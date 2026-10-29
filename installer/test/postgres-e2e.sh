#!/usr/bin/env bash
# Week 4 Day 5: Postgres per app (shared server, own role and database), with
# backup and restore, end to end through the agent.
# Run as root after install.sh (creates and deletes apps pga and pgb).
#   sudo bash installer/test/postgres-e2e.sh
# SC2015: `[[ check ]] && pass || fail` is intended (pass never fails).
# shellcheck disable=SC2015
set -uo pipefail

sock=/run/layer/agent.sock
failures=0

command -v socat >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q socat >/dev/null
pass() { printf '  \e[32m✓\e[0m %s\n' "$1"; }
fail() {
  printf '  \e[31m✗\e[0m %s\n' "$1"
  [[ -n "${2:-}" ]] && printf '%s\n' "$2" | head -20 | sed 's/^/      /'
  failures=$((failures + 1))
}
call() {
  local params="${2:-}"
  [[ -n "$params" ]] || params='{}'
  jq -nc --arg id "c$RANDOM" --arg a "$1" --argjson p "$params" '{id: $id, action: $a, params: $p}' |
    runuser -u layer -- socat -t 900 - "UNIX-CONNECT:$sock" | grep -av '"chunk"' | tail -1
}
expect() { if jq -e "$3" >/dev/null 2>&1 <<<"$2"; then pass "$1"; else fail "$1" "$2"; fi; }
url_of() { jq -r '.postgres | "postgresql://\(.user):\(.password)@127.0.0.1:5432/\(.database)"' "/etc/layer/apps/$1/services.json"; }
# sql <app> <url> <statement>: as that app's Linux user, with the given URL.
sql() { runuser -u "app-$1" -- psql -X -tA -v ON_ERROR_STOP=1 "$2" -c "$3" 2>&1; }

for s in pga pgb; do call app.delete "{\"slug\":\"$s\",\"keepData\":false}" >/dev/null; done

echo "Install"
out="$(call service.install '{"name":"postgres"}')"
expect "service.install postgres" "$out" '.ok == true'
pass "Postgres $(jq -r '.result.version' <<<"$out")"
[[ "$(ss -ltnH 'sport = :5432' | awk '{print $4}' | sort -u | tr '\n' ' ')" == "127.0.0.1:5432 " ]] && pass "listens on 127.0.0.1 only" || fail "listen address" "$(ss -ltn 'sport = :5432')"
grep -q "shared_buffers" /etc/postgresql/*/main/conf.d/layer.conf && pass "tuned for a small box ($(grep shared_buffers /etc/postgresql/*/main/conf.d/layer.conf))" || fail "no layer.conf"

echo "A role and database per app"
for s in pga pgb; do
  call app.create "{\"slug\":\"$s\"}" >/dev/null
  out="$(call postgres.add "{\"slug\":\"$s\"}")"
  expect "postgres.add $s" "$out" '.ok == true'
done
ua="$(url_of pga)"
ub="$(url_of pgb)"
sql pga "$ua" "CREATE TABLE notes (id serial PRIMARY KEY, body text); INSERT INTO notes (body) VALUES ('one'), ('two'), ('three');" >/dev/null
[[ "$(sql pga "$ua" 'SELECT count(*) FROM notes')" == 3 ]] && pass "pga writes to its own database" || fail "pga can't use its database" "$(sql pga "$ua" 'SELECT count(*) FROM notes')"
cross="${ub%/app_pgb}/app_pga"
out="$(sql pgb "$cross" 'SELECT count(*) FROM notes')"
[[ "$out" == *"permission denied"* || "$out" == *"not permitted"* || "$out" == *"failed"* ]] && pass "pgb's role can't connect to pga's database" || fail "cross-app access" "$out"
out="$(sql pga "${ua/:5432/:5432}" "SELECT rolsuper FROM pg_roles WHERE rolname = current_user")"
[[ "$out" == f ]] && pass "app roles aren't superusers" || fail "rolsuper=$out"
grep -q "^DATABASE_URL=\"$ua\"$" /etc/layer/apps/pga/services.env && pass "services.env has DATABASE_URL" || fail "services.env" "$(cat /etc/layer/apps/pga/services.env)"
out="$(call service.status '{"slug":"pga"}')"
expect "service.status shows the database" "$out" '.result.postgres.answering == true and .result.postgres.database == "app_pga"'

echo "Backup and restore include the database"
out="$(call backup.snapshot '{"slug":"pga"}')"
expect "snapshot with a pg_dump" "$out" '.ok == true and .result.postgres.bytes > 0'
file="$(jq -r '.result.file' <<<"$out")"
tar -tzf "/var/lib/layer-staging/$file" | grep -qx './.layer-postgres.dump' && pass "the dump is in the archive" || fail "no dump in the archive" "$(tar -tzf "/var/lib/layer-staging/$file")"
sql pga "$ua" "INSERT INTO notes (body) VALUES ('four'), ('five'); DROP TABLE IF EXISTS extra; CREATE TABLE extra (x int);" >/dev/null
install -d -o layer -g layer -m 700 /var/lib/layer/restore
install -o layer -g layer -m 600 "/var/lib/layer-staging/$file" "/var/lib/layer/restore/$file"
out="$(call backup.restore "{\"slug\":\"pga\",\"file\":\"$file\"}")"
expect "backup.restore" "$out" '.ok == true'
[[ "$(sql pga "$ua" 'SELECT count(*) FROM notes')" == 3 ]] && pass "the database is back at the snapshot (3 rows)" || fail "rows after restore: $(sql pga "$ua" 'SELECT count(*) FROM notes')"
[[ ! -e /srv/apps/pga/data/.layer-postgres.dump ]] && pass "the dump file doesn't stay in data/" || fail "dump left in data/"
call backup.discard "{\"file\":\"$file\"}" >/dev/null
rm -f /var/lib/layer/restore/pga-*

echo "Remove"
out="$(call postgres.remove '{"slug":"pgb"}')"
expect "postgres.remove keeps a dump in the archive" "$out" '.ok == true and (.result.archived | test("pgb-.*\\.pgdump$"))'
archived="$(jq -r '.result.archived' <<<"$out")"
[[ -s "$archived" && "$(stat -c '%U %a' "$archived")" == "root 600" ]] && pass "archived dump is root 600" || fail "archived dump" "$(ls -l "$archived" 2>&1)"
[[ -z "$(runuser -u postgres -- psql -X -tA -c "SELECT 1 FROM pg_roles WHERE rolname = 'app_pgb'")" ]] && pass "role dropped" || fail "role still exists"
call app.delete '{"slug":"pga","keepData":false}' >/dev/null
[[ -z "$(runuser -u postgres -- psql -X -tA -c "SELECT 1 FROM pg_database WHERE datname = 'app_pga'")" ]] && pass "app.delete drops the app's database" || fail "database still exists"
call app.delete '{"slug":"pgb","keepData":false}' >/dev/null
rm -f "$archived"
pass "Postgres uses $(ps -o rss= -C postgres | awk '{s+=$1} END {printf "%d", s/1024}')MB RSS (all processes, shared memory counted per process)"

if ((failures)); then echo "$failures check(s) failed"; exit 1; fi
echo "All Postgres checks passed"

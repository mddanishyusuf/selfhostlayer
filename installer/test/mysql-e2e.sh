#!/usr/bin/env bash
# Weeks 5–6 Day 7: MySQL (MariaDB) per app (shared server, own user and
# database), with backup and restore, end to end through the agent.
# Run as root after install.sh (creates and deletes apps mya, myb, my-db and myxdb).
#   sudo bash installer/test/mysql-e2e.sh
# SC2015: `[[ check ]] && pass || fail` is intended (pass never fails).
# shellcheck disable=SC2015
set -uo pipefail

sock=/run/layer/agent.sock
failures=0
apps=(mya myb my-db myxdb)

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
login() { jq -r ".mysql.$2" "/etc/layer/apps/$1/services.json"; }
# sql <app> <statement> [database]: as that app's Linux user, with its own login over TCP.
sql() {
  runuser -u "app-$1" -- env MYSQL_PWD="$(login "$1" password)" mariadb --protocol=TCP --host=127.0.0.1 --port=3306 \
    --user="$(login "$1" user)" --batch --skip-column-names --execute="$2" "${3:-$(login "$1" database)}" 2>&1
}
root_sql() { mariadb --batch --skip-column-names --execute="$1" 2>&1; }

for s in "${apps[@]}"; do call app.delete "{\"slug\":\"$s\",\"keepData\":false}" >/dev/null; done

echo "Install"
out="$(call service.install '{"name":"mysql"}')"
expect "service.install mysql" "$out" '.ok == true'
pass "$(jq -r '.result.version' <<<"$out")"
[[ "$(ss -ltnH 'sport = :3306' | awk '{print $4}' | sort -u | tr '\n' ' ')" == "127.0.0.1:3306 " ]] && pass "listens on 127.0.0.1 only" || fail "listen address" "$(ss -ltn 'sport = :3306')"
grep -q "innodb_buffer_pool_size" /etc/mysql/mariadb.conf.d/90-layer.cnf && pass "tuned for a small box ($(grep innodb_buffer_pool_size /etc/mysql/mariadb.conf.d/90-layer.cnf))" || fail "no 90-layer.cnf"
[[ "$(root_sql "SELECT COUNT(*) FROM mysql.global_priv WHERE User = ''")" == 0 ]] && pass "no anonymous logins" || fail "anonymous logins exist"
[[ -z "$(root_sql "SHOW DATABASES LIKE 'test'")" ]] && pass "no test database" || fail "a test database exists"

echo "A user and database per app"
for s in "${apps[@]}"; do
  call app.create "{\"slug\":\"$s\"}" >/dev/null
  out="$(call mysql.add "{\"slug\":\"$s\"}")"
  expect "mysql.add $s" "$out" '.ok == true'
done
sql mya "CREATE TABLE notes (id INT AUTO_INCREMENT PRIMARY KEY, body TEXT); INSERT INTO notes (body) VALUES ('one'), ('two'), ('three');" >/dev/null
[[ "$(sql mya 'SELECT COUNT(*) FROM notes')" == 3 ]] && pass "mya writes to its own database" || fail "mya can't use its database" "$(sql mya 'SELECT COUNT(*) FROM notes')"
out="$(sql myb 'SELECT COUNT(*) FROM notes' app_mya)"
[[ "$out" == *"Access denied"* ]] && pass "myb's user can't open mya's database" || fail "cross-app access" "$out"
# In grants _ matches any character: unescaped, app_my_db would cover app_myxdb too.
out="$(sql my-db 'CREATE TABLE stolen (x INT)' app_myxdb)"
[[ "$out" == *"Access denied"* ]] && pass "my-db's user can't open myxdb's database (_ is escaped in the grant)" || fail "the grant's _ matched another app's database" "$out"
[[ "$(sql mya "SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES WHERE PRIVILEGE_TYPE <> 'USAGE'")" == 0 ]] && pass "app users have no server-wide privileges" || fail "global privileges" "$(sql mya 'SHOW GRANTS')"
out="$(runuser -u app-mya -- env MYSQL_PWD="$(login mya password)" mariadb --user=app_mya --execute='SELECT 1' 2>&1)"
[[ "$out" == *"Access denied"* ]] && pass "app users log in over TCP from 127.0.0.1 only, not the local socket" || fail "socket login" "$out"
url="mysql://app_mya:$(login mya password)@127.0.0.1:3306/app_mya"
grep -q "^DATABASE_URL=\"$url\"$" /etc/layer/apps/mya/services.env && pass "services.env has DATABASE_URL" || fail "services.env" "$(cat /etc/layer/apps/mya/services.env)"
out="$(call service.status '{"slug":"mya"}')"
expect "service.status shows the database and its one table" "$out" '.result.mysql.answering == true and .result.mysql.database == "app_mya" and .result.installed.mysql == true and .result.mysql.tables == 1'
out="$(call postgres.add '{"slug":"mya"}')"
expect "Postgres is refused next to MySQL (both use DATABASE_URL)" "$out" '.ok == false and .error.code == "conflict"'

echo "Backup and restore include the database"
out="$(call backup.snapshot '{"slug":"mya"}')"
expect "snapshot with a dump" "$out" '.ok == true and .result.mysql.bytes > 0'
file="$(jq -r '.result.file' <<<"$out")"
tar -tzf "/var/lib/layer-staging/$file" | grep -qx './.layer-mysql.sql' && pass "the dump is in the archive" || fail "no dump in the archive" "$(tar -tzf "/var/lib/layer-staging/$file")"
sql mya "INSERT INTO notes (body) VALUES ('four'), ('five');" >/dev/null
install -d -o layer -g layer -m 700 /var/lib/layer/restore
install -o layer -g layer -m 600 "/var/lib/layer-staging/$file" "/var/lib/layer/restore/$file"
out="$(call backup.restore "{\"slug\":\"mya\",\"file\":\"$file\"}")"
expect "backup.restore" "$out" '.ok == true'
[[ "$(sql mya 'SELECT COUNT(*) FROM notes')" == 3 ]] && pass "the database is back at the snapshot (3 rows)" || fail "rows after restore: $(sql mya 'SELECT COUNT(*) FROM notes')"
[[ ! -e /srv/apps/mya/data/.layer-mysql.sql ]] && pass "the dump file doesn't stay in data/" || fail "dump left in data/"
before="$(jq -r '.result.previous' <<<"$out")"
grep -q "'five'" "/srv/apps/mya/$before/.layer-mysql.sql" && pass "the database as it was before is kept in $before" || fail "no dump of the replaced database" "$(ls -la "/srv/apps/mya/$before" 2>&1)"
call backup.discard "{\"file\":\"$file\"}" >/dev/null
rm -f /var/lib/layer/restore/mya-*

echo "Remove"
out="$(call mysql.remove '{"slug":"myb"}')"
expect "mysql.remove keeps a dump in the archive" "$out" '.ok == true and (.result.archived | test("myb-.*\\.sql$"))'
archived="$(jq -r '.result.archived' <<<"$out")"
[[ -s "$archived" && "$(stat -c '%U %a' "$archived")" == "root 600" ]] && pass "archived dump is root 600" || fail "archived dump" "$(ls -l "$archived" 2>&1)"
[[ "$(root_sql "SELECT COUNT(*) FROM mysql.global_priv WHERE User = 'app_myb'")" == 0 && -z "$(root_sql "SHOW DATABASES LIKE 'app_myb'")" ]] && pass "user and database dropped" || fail "app_myb still exists"
call app.delete '{"slug":"mya","keepData":false}' >/dev/null
[[ -z "$(root_sql "SHOW DATABASES LIKE 'app_mya'")" ]] && pass "app.delete drops the app's database" || fail "database still exists"
for s in "${apps[@]}"; do call app.delete "{\"slug\":\"$s\",\"keepData\":false}" >/dev/null; done
rm -f "$archived"
pass "MariaDB uses $(ps -o rss= -C mariadbd | awk '{s+=$1} END {printf "%d", s/1024}')MB RSS"

if ((failures)); then echo "$failures check(s) failed"; exit 1; fi
echo "All MySQL checks passed"

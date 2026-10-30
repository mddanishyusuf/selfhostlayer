#!/usr/bin/env bash
# MongoDB per app (one shared server from MongoDB's own repository, a user and
# database per app), with backup and restore, end to end through the agent.
# Run as root after install.sh (creates and deletes apps moa, mob and mo-db).
#   sudo bash installer/test/mongodb-e2e.sh
# SC2015: `[[ check ]] && pass || fail` is intended (pass never fails).
# shellcheck disable=SC2015
set -uo pipefail

sock=/run/layer/agent.sock
failures=0
apps=(moa mob mo-db)

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
uri() { jq -r '.mongodb | "mongodb://\(.user):\(.password)@127.0.0.1:27017/\(.database)"' "/etc/layer/apps/$1/services.json"; }
# js <app> <script>: as that app's Linux user, logged in with its own URI.
# From /tmp: mongosh starts in the current folder, which the app user may not enter.
js() { (cd /tmp && runuser -u "app-$1" -- env HOME="/srv/apps/$1" mongosh --quiet --norc "$(uri "$1")" --eval "$2") 2>&1 | tail -1; }
# as_agent <script>: logged in as the agent, to look at what apps can't.
as_agent() { mongosh --quiet --norc "mongodb://layer:$(jq -r .password /var/lib/layer-agent/mongodb-admin.json)@127.0.0.1:27017/admin" --eval "$1" 2>&1 | tail -1; }

for s in "${apps[@]}"; do call app.delete "{\"slug\":\"$s\",\"keepData\":false}" >/dev/null; done

echo "Install"
out="$(call service.install '{"name":"mongodb"}')"
expect "service.install mongodb" "$out" '.ok == true'
pass "MongoDB $(jq -r '.result.version' <<<"$out")"
[[ "$(ss -ltnH 'sport = :27017' | awk '{print $4}' | sort -u | tr '\n' ' ')" == "127.0.0.1:27017 " ]] && pass "listens on 127.0.0.1 only" || fail "listen address" "$(ss -ltn 'sport = :27017')"
out="$(mongosh --quiet --norc mongodb://127.0.0.1:27017/admin --eval 'db.adminCommand({ listDatabases: 1 }).ok' 2>&1 | tail -1)"
[[ "$out" == *"requires authentication"* || "$out" == *"Unauthorized"* ]] && pass "nothing works without a login" || fail "unauthenticated access" "$out"
grep -q "^  authorization: enabled$" /etc/mongodb-layer.conf && grep -q "cacheSizeGB" /etc/mongodb-layer.conf && pass "tuned for a small box ($(grep -o 'cacheSizeGB: .*' /etc/mongodb-layer.conf))" || fail "no /etc/mongodb-layer.conf"
systemctl cat mongod | grep -q "^ExecStart=/usr/bin/mongod --config /etc/mongodb-layer.conf$" && pass "mongod runs with those settings (the package's /etc/mongod.conf is untouched)" || fail "mongod's ExecStart" "$(systemctl cat mongod)"
[[ "$(ps -o user= -C mongod | sort -u)" == mongodb ]] && pass "mongod runs as the mongodb user" || fail "mongod's user" "$(ps -o user=,cmd= -C mongod)"
tunables="$(tr '\0' '\n' <"/proc/$(pgrep -xo mongod)/environ" | grep '^GLIBC_TUNABLES=')"
[[ "$tunables" == "GLIBC_TUNABLES=glibc.pthread.rseq=1" ]] && pass "per-thread allocator caches, so it starts on kernels 6.19.0 to 7.0.13 too" || fail "mongod's GLIBC_TUNABLES" "$tunables"
grep -q "enableTelemetry: false" /etc/mongosh.conf && pass "mongosh sends no usage data" || fail "mongosh telemetry is on"
[[ "$(stat -c '%U %a' /var/lib/layer-agent/mongodb-admin.json)" == "root 600" ]] && pass "the agent's own login is root 600" || fail "agent login file" "$(ls -l /var/lib/layer-agent/mongodb-admin.json 2>&1)"
out="$(call service.install '{"name":"mongodb"}')"
expect "installing again is harmless" "$out" '.ok == true and .result.already == true'

echo "A MongoDB that can't start says why, and stops retrying"
mode="$(stat -c %a /var/lib/mongodb)"
chmod 000 /var/lib/mongodb
out="$(call service.install '{"name":"mongodb"}')"
expect "service.install says why from mongod's log" "$out" '.ok == false and .error.code == "start_failed" and (.error.message | test("From its log: .*Permission denied"))'
[[ "$(systemctl is-active mongod)" != active && "$(systemctl is-enabled mongod)" == disabled ]] && pass "mongod is stopped, not failing again every 5 s" || fail "mongod after a failed start" "$(systemctl status mongod --no-pager 2>&1 | head -5)"
expect "service.status says it's stopped" "$(call service.status)" '.result.running.mongodb == false'
grep '"phase":"end"' /var/log/layer/audit.jsonl | tail -1 | jq -e '.code == "start_failed" and (.message | test("Permission denied"))' >/dev/null && pass "the Activity log keeps why it failed" || fail "audit entry" "$(tail -1 /var/log/layer/audit.jsonl)"
chmod "$mode" /var/lib/mongodb
out="$(call service.install '{"name":"mongodb"}')"
expect "installing again brings it back" "$out" '.ok == true'
[[ "$(systemctl is-enabled mongod)" == enabled ]] && pass "mongod starts at boot again" || fail "mongod isn't enabled"

echo "A user and database per app"
for s in "${apps[@]}"; do
  call app.create "{\"slug\":\"$s\"}" >/dev/null
  out="$(call mongodb.add "{\"slug\":\"$s\"}")"
  expect "mongodb.add $s" "$out" '.ok == true and .result.env == ["MONGODB_URI"]'
done
[[ "$(js moa 'db.notes.insertMany([{ b: "one" }, { b: "two" }, { b: "three" }]); db.notes.countDocuments()')" == 3 ]] && pass "moa writes to its own database" || fail "moa can't use its database" "$(js moa 'db.notes.countDocuments()')"
out="$(js mob 'db.getSiblingDB("app_moa").notes.countDocuments()')"
[[ "$out" == *"not authorized"* || "$out" == *"Unauthorized"* ]] && pass "mob's user can't read moa's database" || fail "cross-app read" "$out"
out="$(js mob 'db.getSiblingDB("app_moa").notes.insertOne({ b: "x" })')"
[[ "$out" == *"not authorized"* || "$out" == *"Unauthorized"* ]] && pass "mob's user can't write moa's database" || fail "cross-app write" "$out"
out="$(js mob 'JSON.stringify(db.adminCommand({ listDatabases: 1, nameOnly: true, authorizedDatabases: true }).databases.map((d) => d.name))')"
[[ "$out" != *app_moa* ]] && pass "an app doesn't even see other apps' databases ($out)" || fail "listDatabases shows others" "$out"
[[ "$(js mo-db 'db.x.insertOne({ a: 1 }); db.x.countDocuments()')" == 1 ]] && pass "a slug with a dash works (app_mo_db)" || fail "mo-db can't use its database"
url="$(uri moa)"
grep -q "^MONGODB_URI=\"$url\"$" /etc/layer/apps/moa/services.env && pass "services.env has MONGODB_URI" || fail "services.env" "$(cat /etc/layer/apps/moa/services.env)"
out="$(call service.status '{"slug":"moa"}')"
expect "service.status shows the database and its one collection" "$out" '.result.mongodb.answering == true and .result.mongodb.database == "app_moa" and .result.installed.mongodb == true and .result.running.mongodb == true and .result.mongodb.collections == 1'

echo "Backup and restore include the database"
out="$(call backup.snapshot '{"slug":"moa"}')"
expect "snapshot with a mongodump" "$out" '.ok == true and .result.mongodb.bytes > 0'
file="$(jq -r '.result.file' <<<"$out")"
tar -tzf "/var/lib/layer-staging/$file" | grep -qx './.layer-mongodb.archive' && pass "the dump is in the archive" || fail "no dump in the archive" "$(tar -tzf "/var/lib/layer-staging/$file")"
[[ "$(js moa 'db.notes.insertMany([{ b: "four" }, { b: "five" }]); db.notes.countDocuments()')" == 5 ]] || fail "couldn't add rows after the snapshot"
install -d -o layer -g layer -m 700 /var/lib/layer/restore
install -o layer -g layer -m 600 "/var/lib/layer-staging/$file" "/var/lib/layer/restore/$file"
out="$(call backup.restore "{\"slug\":\"moa\",\"file\":\"$file\"}")"
expect "backup.restore" "$out" '.ok == true'
[[ "$(js moa 'db.notes.countDocuments()')" == 3 ]] && pass "the database is back at the snapshot (3 documents)" || fail "documents after restore: $(js moa 'db.notes.countDocuments()')"
[[ ! -e /srv/apps/moa/data/.layer-mongodb.archive ]] && pass "the dump file doesn't stay in data/" || fail "dump left in data/"
before="$(jq -r '.result.previous' <<<"$out")"
[[ -s "/srv/apps/moa/$before/.layer-mongodb.archive" ]] && pass "the database as it was before is kept in $before" || fail "no dump of the replaced database" "$(ls -la "/srv/apps/moa/$before" 2>&1)"
call backup.discard "{\"file\":\"$file\"}" >/dev/null
rm -f /var/lib/layer/restore/moa-*

echo "Remove"
out="$(call mongodb.remove '{"slug":"mob"}')"
expect "mongodb.remove keeps a dump in the archive" "$out" '.ok == true and (.result.archived | test("mob-.*\\.mongodump\\.gz$"))'
archived="$(jq -r '.result.archived' <<<"$out")"
[[ -s "$archived" && "$(stat -c '%U %a' "$archived")" == "root 600" ]] && pass "archived dump is root 600" || fail "archived dump" "$(ls -l "$archived" 2>&1)"
[[ "$(as_agent 'db.getSiblingDB("app_mob").getUser("app_mob") === null')" == true ]] && pass "mob's user is dropped" || fail "app_mob still exists"
! grep -q MONGODB_URI /etc/layer/apps/mob/services.env && pass "MONGODB_URI is gone from services.env" || fail "services.env still has MONGODB_URI"
call app.delete '{"slug":"moa","keepData":false}' >/dev/null
[[ "$(as_agent 'db.adminCommand({ listDatabases: 1, nameOnly: true }).databases.some((d) => d.name === "app_moa")')" == false ]] && pass "app.delete drops the app's database" || fail "app_moa still exists"
for s in "${apps[@]}"; do call app.delete "{\"slug\":\"$s\",\"keepData\":false}" >/dev/null; done
rm -f "$archived"
pass "mongod uses $(ps -o rss= -C mongod | awk '{s+=$1} END {printf "%d", s/1024}')MB RSS"

if ((failures)); then echo "$failures check(s) failed"; exit 1; fi
echo "All MongoDB checks passed"

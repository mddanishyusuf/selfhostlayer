#!/usr/bin/env bash
# The database viewer (db.browse) against real databases: SQLite, Postgres,
# MariaDB, MongoDB and Redis, each read through the app's own login, and
# nothing written whatever the query says.
# Run as root after install.sh (installs the engines it needs; creates and
# deletes apps vwa and vwb).
#   sudo bash installer/test/browse-e2e.sh
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
# browse <params JSON>: db.browse on app vwa unless the params name another.
browse() { call db.browse "$(jq -c '{slug: "vwa"} + .' <<<"$1")"; }
env_of() { sed -n "s/^$2=\"\(.*\)\"$/\1/p" "/etc/layer/apps/$1/services.env"; }

for s in vwa vwb; do call app.delete "{\"slug\":\"$s\",\"keepData\":false}" >/dev/null; done
call app.create '{"slug":"vwa"}' >/dev/null
call app.create '{"slug":"vwb"}' >/dev/null

echo "SQLite"
# A WAL database the app's user wrote and still has open, like a running app's.
(cd /srv/apps/vwa/data && runuser -u app-vwa -- /opt/layer/runtime/bin/node --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("app.db");
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE licenses (id INTEGER PRIMARY KEY, email TEXT, notes TEXT, avatar BLOB); CREATE VIEW recent AS SELECT id, email FROM licenses WHERE id > 1");
  const ins = db.prepare("INSERT INTO licenses (email, notes, avatar) VALUES (?, ?, ?)");
  ins.run("a@x.com", "short", null); ins.run("b@x.com", "x".repeat(5000), new Uint8Array(3)); ins.run("c@x.com", null, null);
  require("node:fs").writeFileSync("notes.txt", "not a database");
  setTimeout(() => {}, 8000);' &)
sleep 2
out="$(browse '{"engine":"sqlite"}')"
expect "finds the SQLite databases in data/ by their header, with their tables" "$out" '.ok and (.result.files | map(.path)) == ["app.db"] and .result.files[0].tables == 1'
expect "an empty data folder has none" "$(call db.browse '{"slug":"vwb","engine":"sqlite"}')" '.ok and .result.files == []'
out="$(browse '{"engine":"sqlite","file":"app.db"}')"
expect "lists its tables and views, with row counts" "$out" '.ok and .result.tables == [{"name":"licenses","type":"table","rows":3},{"name":"recent","type":"view","rows":null}]'
out="$(browse '{"engine":"sqlite","file":"app.db","op":"rows","table":"licenses","sort":"id","desc":true,"limit":2}')"
expect "a page of rows, sorted, with the total" "$out" '.ok and .result.result.total == 3 and (.result.result.rows | map(.[0])) == [3, 2]'
expect "long text is cut with its length, binary shown as a size" "$out" '.result.result.rows[1][2].length == 5000 and .result.result.rows[1][3] == {"bytes":3}'
out="$(browse '{"engine":"sqlite","file":"app.db","op":"query","query":"SELECT email FROM recent ORDER BY id"}')"
expect "a query" "$out" '.ok and .result.result.columns == ["email"] and .result.result.rows == [["b@x.com"],["c@x.com"]]'
out="$(browse '{"engine":"sqlite","file":"app.db","op":"query","query":"DELETE FROM licenses"}')"
expect "a write is refused (opened read-only)" "$out" '.ok == false and (.error.message | test("readonly"))'
out="$(browse '{"engine":"sqlite","file":"app.db","op":"query","query":"SELECT 1; DELETE FROM licenses"}')"
expect "two statements are refused before anything runs" "$out" '.ok == false and .error.code == "invalid_params"'
out="$(browse '{"engine":"sqlite","file":"notes.txt"}')"
expect "a file that isn't SQLite is refused" "$out" '.ok == false and (.error.message | test("isn.t a SQLite database"))'

echo "Postgres"
expect "service.install postgres" "$(call service.install '{"name":"postgres"}')" '.ok'
expect "postgres.add vwa" "$(call postgres.add '{"slug":"vwa"}')" '.ok'
pg="$(env_of vwa DATABASE_URL)"
runuser -u app-vwa -- psql -X -q -v ON_ERROR_STOP=1 "$pg" -c "CREATE TABLE notes (id serial PRIMARY KEY, body text, meta jsonb); INSERT INTO notes (body, meta) VALUES ('first', '{\"tags\": [\"a\"]}'), ('second', NULL); CREATE SCHEMA billing; CREATE TABLE billing.invoices (n int); INSERT INTO billing.invoices VALUES (7)" >/dev/null 2>&1
out="$(browse '{"engine":"postgres"}')"
expect "lists its tables, other schemas as schema.table" "$out" '.ok and (.result.tables | map(.name)) == ["notes","billing.invoices"]'
out="$(browse '{"engine":"postgres","op":"rows","table":"notes","sort":"id"}')"
expect "a page of rows, with JSON as JSON" "$out" '.ok and .result.result.total == 2 and .result.result.columns == ["id","body","meta"] and .result.result.rows[0][2] == "{\"tags\":[\"a\"]}" and .result.result.rows[1][2] == null'
out="$(browse '{"engine":"postgres","op":"rows","table":"billing.invoices"}')"
expect "a table in another schema" "$out" '.ok and .result.result.rows == [[7]]'
out="$(browse '{"engine":"postgres","op":"query","query":"SELECT body FROM notes WHERE id = 2 -- the second"}')"
expect "a query, with a comment at the end" "$out" '.ok and .result.result.rows == [["second"]]'
out="$(browse '{"engine":"postgres","op":"query","query":"WITH d AS (DELETE FROM notes RETURNING *) SELECT * FROM d"}')"
expect "a write hidden in a query is refused" "$out" '.ok == false'
out="$(browse '{"engine":"postgres","op":"query","query":"SELECT pg_sleep(8)"}')"
expect "a query is stopped after 5 s" "$out" '.ok == false and (.error.message | test("timeout|cancel"))'
[[ "$(runuser -u app-vwa -- psql -X -tA "$pg" -c "SELECT count(*) FROM notes")" == 2 ]] && pass "nothing was written" || fail "rows changed"

echo "MySQL (MariaDB)"
expect "service.install mysql" "$(call service.install '{"name":"mysql"}')" '.ok'
expect "mysql.add vwb" "$(call mysql.add '{"slug":"vwb"}')" '.ok'
my="$(jq -r '.mysql | "\(.user) \(.password) \(.database)"' /etc/layer/apps/vwb/services.json)"
read -r my_user my_pw my_db <<<"$my"
runuser -u app-vwb -- env MYSQL_PWD="$my_pw" mariadb --protocol=TCP --host=127.0.0.1 --port=3306 --user="$my_user" "$my_db" \
  --execute="CREATE TABLE items (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(40), note TEXT NULL); INSERT INTO items (name, note) VALUES ('<b>&amp;</b>', NULL), ('two', 'NULL')" 2>&1
out="$(browse '{"slug":"vwb","engine":"mysql"}')"
expect "lists its tables" "$out" '.ok and (.result.tables | map(.name)) == ["items"]'
out="$(browse '{"slug":"vwb","engine":"mysql","op":"rows","table":"items","sort":"id"}')"
expect "a page of rows: NULL apart from the text \"NULL\", markup as text" "$out" '.ok and .result.result.total == 2 and .result.result.rows == [["1","<b>&amp;</b>",null],["2","two","NULL"]]'
out="$(browse '{"slug":"vwb","engine":"mysql","op":"query","query":"SELECT name FROM items WHERE id = 2;"}')"
expect "a query, with a trailing ;" "$out" '.ok and .result.result.rows == [["two"]]'
out="$(browse '{"slug":"vwb","engine":"mysql","op":"query","query":"DELETE FROM items"}')"
expect "a write is refused" "$out" '.ok == false'
[[ "$(runuser -u app-vwb -- env MYSQL_PWD="$my_pw" mariadb --protocol=TCP --host=127.0.0.1 --user="$my_user" --batch --skip-column-names "$my_db" --execute='SELECT COUNT(*) FROM items')" == 2 ]] && pass "nothing was written" || fail "rows changed"

echo "MongoDB"
expect "service.install mongodb" "$(call service.install '{"name":"mongodb"}')" '.ok'
expect "mongodb.add vwa" "$(call mongodb.add '{"slug":"vwa"}')" '.ok'
mg="$(env_of vwa MONGODB_URI)"
(cd /tmp && runuser -u app-vwa -- env HOME=/tmp mongosh --quiet --norc "$mg" --eval 'db.posts.insertMany([{ title: "a", tags: ["x"], at: new Date("2026-01-02T03:04:05Z") }, { title: "b", n: 2 }])' >/dev/null 2>&1)
out="$(browse '{"engine":"mongodb"}')"
expect "lists its collections, with counts" "$out" '.ok and .result.tables == [{"name":"posts","type":"collection","rows":2}]'
out="$(browse '{"engine":"mongodb","op":"rows","table":"posts","sort":"title"}')"
expect "documents as rows: _id first, every field, a missing one marked" "$out" '.ok and .result.result.columns[0] == "_id" and (.result.result.columns | index("tags")) != null and .result.result.rows[0][1] == "a" and .result.result.rows[0][3] == "2026-01-02T03:04:05.000Z" and .result.result.rows[1][2] == {"missing":true}'
out="$(browse '{"engine":"mongodb","op":"query","table":"posts","query":"{\"title\": \"b\"}"}')"
expect "a filter" "$out" '.ok and .result.result.total == 1 and .result.result.rows[0][1] == "b"'
# SC2016: $where is MongoDB's operator, meant literally.
# shellcheck disable=SC2016
out="$(browse '{"engine":"mongodb","op":"query","table":"posts","query":"{\"$where\": \"true\"}"}')"
expect "a filter that would run JavaScript is refused" "$out" '.ok == false and .error.code == "invalid_params"'

echo "Redis"
expect "service.install redis" "$(call service.install '{"name":"redis"}')" '.ok'
expect "redis.add vwa" "$(call redis.add '{"slug":"vwa","memoryMb":32}')" '.ok'
port="$(jq -r .redis.port /etc/layer/apps/vwa/services.json)"
pw="$(jq -r .redis.password /etc/layer/apps/vwa/services.json)"
cli="$(command -v redis-cli || command -v valkey-cli)"
for c in "SET greeting hello" "HSET stats visits 10 signups 2" "RPUSH queue a b c" "EXPIRE greeting 600"; do
  # shellcheck disable=SC2086
  REDISCLI_AUTH="$pw" "$cli" --no-auth-warning -h 127.0.0.1 -p "$port" $c >/dev/null
done
out="$(browse '{"engine":"redis"}')"
expect "lists its keys, with types and lengths" "$out" '.ok and .result.tables == [{"name":"greeting","type":"string","rows":5},{"name":"queue","type":"list","rows":3},{"name":"stats","type":"hash","rows":2}]'
out="$(browse '{"engine":"redis","op":"rows","table":"stats"}')"
expect "a hash's fields" "$out" '.ok and .result.result.columns == ["field","value"] and (.result.result.rows | sort) == [["signups","2"],["visits","10"]]'
out="$(browse '{"engine":"redis","op":"rows","table":"queue","offset":1,"limit":2}')"
expect "a page of a list, with its indexes" "$out" '.ok and .result.result.rows == [[1,"b"],[2,"c"]] and .result.result.total == 3'
out="$(browse '{"engine":"redis","op":"rows","table":"greeting"}')"
expect "a string, with its expiry" "$out" '.ok and .result.result.rows == [["hello"]] and .result.result.ttl > 500'
out="$(browse '{"engine":"redis","op":"query","query":"q*"}')"
expect "a key pattern" "$out" '.ok and (.result.tables | map(.name)) == ["queue"]'

for s in vwa vwb; do call app.delete "{\"slug\":\"$s\",\"keepData\":false}" >/dev/null; done
if ((failures)); then echo "$failures check(s) failed"; exit 1; fi
echo "All viewer checks passed"

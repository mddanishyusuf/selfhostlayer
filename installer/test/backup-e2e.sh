#!/usr/bin/env bash
# Week 4 Day 1: backup snapshot and restore, end to end through the agent.
# Run as root after install.sh (creates and deletes an app named bktest).
#   sudo bash installer/test/backup-e2e.sh
# SC2015: `[[ check ]] && pass || fail` is intended (pass never fails).
# shellcheck disable=SC2015
set -uo pipefail

sock=/run/layer/agent.sock
slug=bktest
app=/srv/apps/$slug
node=/opt/layer/runtime/bin/node
staging=/var/lib/layer-staging
restore_dir=/var/lib/layer/restore
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
    runuser -u layer -- socat -t 600 - "UNIX-CONNECT:$sock" | grep -av '"chunk"' | tail -1
}
expect() { if jq -e "$3" >/dev/null 2>&1 <<<"$2"; then pass "$1"; else fail "$1" "$2"; fi; }
# rows <db file>: row count, as the app user (prints "error: …" on failure).
rows() {
  runuser -u "app-$slug" -- "$node" --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    try { const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(db.prepare("SELECT count(*) AS n FROM hits").get().n); }
    catch (e) { console.log("error: " + e.message); }' "$1"
}

systemctl stop layer-test-writer 2>/dev/null
call app.delete "{\"slug\":\"$slug\",\"keepData\":false}" >/dev/null

echo "Setup: an app writing to SQLite (WAL) nonstop, plus an upload"
call app.create "{\"slug\":\"$slug\"}" >/dev/null
runuser -u "app-$slug" -- mkdir -p "$app/data/uploads" "$app/data/db"
echo "hello" | runuser -u "app-$slug" -- tee "$app/data/uploads/hello.txt" >/dev/null
systemctl reset-failed layer-test-writer 2>/dev/null
systemd-run --quiet --unit=layer-test-writer --uid="app-$slug" --gid="app-$slug" "$node" --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/srv/apps/bktest/data/db/app.sqlite3");
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS hits (id INTEGER PRIMARY KEY, at TEXT, pad TEXT)");
  const insert = db.prepare("INSERT INTO hits (at, pad) VALUES (?, ?)");
  setInterval(() => { db.exec("BEGIN"); for (let i = 0; i < 50; i++) insert.run(new Date().toISOString(), "x".repeat(200)); db.exec("COMMIT"); }, 5);'
sleep 3
[[ -f "$app/data/db/app.sqlite3-wal" ]] && pass "the writer is running in WAL mode ($(rows "$app/data/db/app.sqlite3") rows so far)" || fail "no WAL file"

echo "Snapshot while it writes"
out="$(call backup.snapshot "{\"slug\":\"$slug\"}")"
expect "backup.snapshot succeeded" "$out" '.ok == true'
expect "it found the database by its header and checked it" "$out" '.result.sqlite | map(.path) == ["db/app.sqlite3"]'
file="$(jq -r '.result.file' <<<"$out")"
staged="$staging/$file"
[[ "$(stat -c '%U:%G %a' "$staged")" == "root:layer 640" ]] && pass "staged as root:layer 640" || fail "staged file owner/mode: $(stat -c '%U:%G %a' "$staged")"
[[ "$(stat -c '%U:%G %a' "$staging")" == "root:layer 750" ]] && pass "staging folder is root:layer 750" || fail "staging folder: $(stat -c '%U:%G %a' "$staging")"
list="$(tar -tzf "$staged")"
grep -qx './uploads/hello.txt' <<<"$list" && grep -qx './db/app.sqlite3' <<<"$list" && pass "archive has the upload and the database at their own paths" || fail "archive listing" "$list"
grep -qE 'sqlite3-(wal|shm)$|layer-snapshot' <<<"$list" && fail "archive has live -wal/-shm files or snapshot folders" "$list" || pass "no -wal/-shm, no temp folders"
[[ "$(grep -cx './db/app.sqlite3' <<<"$list")" == 1 ]] && pass "the database is in the archive once" || fail "database appears $(grep -cx './db/app.sqlite3' <<<"$list") times"

check="$(mktemp -d)"
tar -xzf "$staged" -C "$check"
chown -R "app-$slug:app-$slug" "$check"
snap_rows="$(rows "$check/db/app.sqlite3")"
integrity="$(runuser -u "app-$slug" -- "$node" --no-warnings -e 'const { DatabaseSync } = require("node:sqlite"); console.log(new DatabaseSync(process.argv[1]).prepare("PRAGMA integrity_check").get().integrity_check)' "$check/db/app.sqlite3")"
[[ "$snap_rows" =~ ^[0-9]+$ && "$snap_rows" -gt 0 && "$integrity" == ok ]] && pass "the copy opens on its own: $snap_rows rows, integrity ok" || fail "copy: rows=$snap_rows integrity=$integrity"
rm -rf "$check"

echo "Restore"
systemctl stop layer-test-writer
live_rows="$(rows "$app/data/db/app.sqlite3")"
[[ "$live_rows" -gt "$snap_rows" ]] && pass "the live database moved on ($live_rows rows)" || fail "live rows $live_rows not > $snap_rows"
install -d -o layer -g layer -m 700 "$restore_dir"
install -o layer -g layer -m 600 "$staged" "$restore_dir/$file"
rm -f "$app/data/uploads/hello.txt"
out="$(call backup.restore "{\"slug\":\"$slug\",\"file\":\"$file\"}")"
expect "backup.restore succeeded" "$out" '.ok == true'
[[ "$(rows "$app/data/db/app.sqlite3")" == "$snap_rows" ]] && pass "the database is back at the snapshot ($snap_rows rows)" || fail "restored rows: $(rows "$app/data/db/app.sqlite3")"
[[ "$(cat "$app/data/uploads/hello.txt" 2>/dev/null)" == hello ]] && pass "the deleted upload is back" || fail "upload missing"
[[ "$(stat -c '%U %a' "$app/data")" == "app-$slug 700" ]] && pass "data/ is the app's, 700" || fail "data/: $(stat -c '%U %a' "$app/data")"
prev="$(jq -r '.result.previous' <<<"$out")"
[[ "$(rows "$app/$prev/db/app.sqlite3")" == "$live_rows" ]] && pass "the replaced data is kept in $prev" || fail "previous data not kept"

echo "Guards"
broken="$slug-20261029000000-0badf00d.tar.gz"
echo "not a tarball" | install -o layer -g layer -m 600 /dev/stdin "$restore_dir/$broken"
out="$(call backup.restore "{\"slug\":\"$slug\",\"file\":\"$broken\"}")"
expect "a broken archive is refused" "$out" '.ok == false'
[[ "$(rows "$app/data/db/app.sqlite3")" == "$snap_rows" ]] && pass "and data/ is unchanged" || fail "data changed after a failed restore"
chown root:root "$restore_dir/$file"
out="$(call backup.restore "{\"slug\":\"$slug\",\"file\":\"$file\"}")"
expect "a file the panel doesn't own is refused" "$out" '.ok == false and .error.code == "forbidden"'
ln -sf /etc/shadow "$restore_dir/$slug-20261029000000-5ca1ab1e.tar.gz"
out="$(call backup.restore "{\"slug\":\"$slug\",\"file\":\"$slug-20261029000000-5ca1ab1e.tar.gz\"}")"
expect "a symlink is refused" "$out" '.ok == false'
runuser -u "app-$slug" -- ls "$staging" >/dev/null 2>&1 && fail "the app user can list the staging folder" || pass "the app can't see staged backups"

echo "Discard and clean up"
out="$(call backup.discard "{\"file\":\"$file\"}")"
expect "backup.discard removes the staged file" "$out" '.ok == true and .result.discarded == true'
rm -f "$restore_dir"/"$slug"-*
call app.delete "{\"slug\":\"$slug\",\"keepData\":false}" >/dev/null

if ((failures)); then echo "$failures check(s) failed"; exit 1; fi
echo "All backup checks passed"

#!/usr/bin/env bash
# Weeks 5-6 Day 1: importing a data folder from another server (data.import),
# end to end through the agent and the layer CLI.
# Run as root after install.sh (creates and deletes an app named imtest).
#   sudo bash installer/test/import-e2e.sh
# SC2015: `[[ check ]] && pass || fail` is intended (pass never fails).
# shellcheck disable=SC2015
set -uo pipefail

sock=/run/layer/agent.sock
slug=imtest
app=/srv/apps/$slug
node=/opt/layer/runtime/bin/node
restore_dir=/var/lib/layer/restore
work="$(mktemp -d)"
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
# rows <db file>: rows in "hits", as the app user (prints "error: …" on failure).
rows() {
  runuser -u "app-$slug" -- "$node" --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    try { const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(db.prepare("SELECT count(*) AS n FROM hits").get().n); }
    catch (e) { console.log("error: " + e.message); }' "$1"
}
# make_db <file> <rows> [wal]: a database with <rows> rows in "hits". With wal,
# it is copied while still open, so the copy has a -wal SQLite must replay:
# what you get when you copy a live database off another server.
make_db() {
  "$node" --no-warnings -e '
    const fs = require("node:fs");
    const { DatabaseSync } = require("node:sqlite");
    const [file, n, wal] = process.argv.slice(1);
    const tmp = file + ".tmp";
    const db = new DatabaseSync(tmp);
    if (wal) db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    db.exec("CREATE TABLE hits (id INTEGER PRIMARY KEY, pad TEXT)");
    const insert = db.prepare("INSERT INTO hits (pad) VALUES (?)");
    db.exec("BEGIN");
    for (let i = 0; i < Number(n); i++) insert.run("x".repeat(100));
    db.exec("COMMIT");
    if (wal) { fs.copyFileSync(tmp, file); fs.copyFileSync(tmp + "-wal", file + "-wal"); }
    db.close();
    if (!wal) fs.renameSync(tmp, file);
    for (const f of [tmp, tmp + "-wal", tmp + "-shm"]) fs.rmSync(f, { force: true });' "$@"
}
# stage <archive>: hand a file to the agent the way the panel does (its own, in its restore folder).
stage() {
  local name
  name="$slug-$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 4).tar.gz"
  install -d -o layer -g layer -m 700 "$restore_dir"
  install -o layer -g layer -m 600 "$1" "$restore_dir/$name"
  echo "$name"
}
# import <archive>: what the panel does: stage, call, delete the staged file.
import() {
  local name
  name="$(stage "$1")"
  call data.import "{\"slug\":\"$slug\",\"file\":\"$name\"}"
  rm -f "$restore_dir/$name"
}

call app.delete "{\"slug\":\"$slug\",\"keepData\":false}" >/dev/null
call app.create "{\"slug\":\"$slug\"}" >/dev/null
echo "old" | runuser -u "app-$slug" -- tee "$app/data/old.txt" >/dev/null

echo "An archive of a data/ folder, copied live (with a -wal), packed on a Mac"
mkdir -p "$work/a/data/db" "$work/a/data/uploads"
make_db "$work/a/data/db/app.sqlite3" 500 wal
head -c 32768 /dev/urandom >"$work/a/data/db/app.sqlite3-shm"
echo "hello" >"$work/a/data/uploads/a.txt"
touch "$work/a/data/.DS_Store" "$work/a/data/db/._app.sqlite3"
chmod 644 "$work/a/data/uploads/a.txt"
[[ -s "$work/a/data/db/app.sqlite3-wal" ]] && pass "the copied database has a -wal to replay" || fail "no -wal in the test archive"
tar -czf "$work/a.tar.gz" -C "$work/a" data
out="$(import "$work/a.tar.gz")"
expect "data.import succeeded" "$out" '.ok == true'
expect "it found and checked the database" "$out" '.result.sqlite | map(.path) == ["db/app.sqlite3"]'
# Before anything opens it: any connection to a WAL database makes its own -wal and -shm.
[[ ! -e "$app/data/db/app.sqlite3-wal" && ! -e "$app/data/db/app.sqlite3-shm" ]] && pass "the -wal was folded in, and the stale -shm is gone" || fail "leftover WAL files" "$(ls -la "$app/data/db")"
[[ "$(rows "$app/data/db/app.sqlite3")" == 500 ]] && pass "all 500 rows are there" || fail "rows after import: $(rows "$app/data/db/app.sqlite3")"
[[ "$(cat "$app/data/uploads/a.txt")" == hello ]] && pass "the upload is there" || fail "upload missing"
[[ ! -e "$app/data/.DS_Store" && ! -e "$app/data/db/._app.sqlite3" ]] && pass "macOS litter is dropped" || fail "litter imported"
[[ "$(stat -c '%U %a' "$app/data")" == "app-$slug 700" ]] && pass "data/ is the app's, 700" || fail "data/: $(stat -c '%U %a' "$app/data")"
[[ "$(stat -c '%U %a' "$app/data/uploads/a.txt")" == "app-$slug 600" ]] && pass "files are the app's alone (644 became 600)" || fail "file: $(stat -c '%U %a' "$app/data/uploads/a.txt")"
prev="$(jq -r '.result.previous' <<<"$out")"
[[ "$(cat "$app/$prev/old.txt" 2>/dev/null)" == old ]] && pass "the replaced data is kept in $prev" || fail "previous data not kept"

echo "The folder's contents as a plain tar, through the layer CLI"
mkdir -p "$work/b"
make_db "$work/b/app.sqlite3" 42
tar -cf "$work/b.tar" -C "$work/b" .
cli="$(layer import "$slug" "$work/b.tar" 2>&1)"
grep -q "Imported" <<<"$cli" && pass "layer import works: $(grep Imported <<<"$cli" | sed 's/\x1b\[[0-9;]*m//g')" || fail "layer import" "$cli"
[[ "$(rows "$app/data/app.sqlite3")" == 42 ]] && pass "the new data is in place (42 rows)" || fail "rows after the CLI import: $(rows "$app/data/app.sqlite3")"
[[ "$(find "$app" -maxdepth 1 -name 'data.before-restore-*' | wc -l)" == 1 ]] && pass "only the latest replaced folder is kept" || fail "replaced folders: $(find "$app" -maxdepth 1 -name 'data.*')"
[[ -z "$(ls "$restore_dir")" ]] && pass "the CLI cleaned up its copy" || fail "files left in $restore_dir" "$(ls "$restore_dir")"

echo "An app with Redis: Redis stops for the swap and comes back on the new data/"
out="$(call service.install '{"name":"redis"}')"
expect "Redis is installed" "$out" '.ok == true'
out="$(call redis.add "{\"slug\":\"$slug\",\"memoryMb\":32}")"
expect "the app has its own Redis" "$out" '.ok == true'
out="$(import "$work/b.tar")"
expect "the import restarted Redis too" "$out" '.ok == true and (.result.restarted | index("layer-redis-imtest.service") != null)'
[[ "$(stat -c '%U %a' "$app/data/redis" 2>/dev/null)" == "app-$slug 700" ]] && pass "data/redis is back (the archive had none)" || fail "data/redis: $(stat -c '%U %a' "$app/data/redis" 2>&1)"
systemctl is-active --quiet "layer-redis-$slug" && pass "Redis runs again" || fail "Redis isn't running" "$(journalctl -u "layer-redis-$slug" -n 5 --no-pager)"
call redis.remove "{\"slug\":\"$slug\",\"keepData\":false}" >/dev/null

echo "Refused, and nothing changes"
mkdir -p "$work/c"
make_db "$work/c/app.sqlite3" 5000
dd if=/dev/urandom of="$work/c/app.sqlite3" bs=4096 seek=3 count=20 conv=notrunc status=none
tar -czf "$work/c.tar.gz" -C "$work/c" .
out="$(import "$work/c.tar.gz")"
expect "a damaged database is refused" "$out" '.ok == false and (.error.message | test("integrity check"))'
echo "not an archive" >"$work/d.tar.gz"
out="$(import "$work/d.tar.gz")"
expect "a file that isn't an archive is refused" "$out" '.ok == false and .error.code == "bad_archive"'
mkdir -p "$work/empty"
tar -czf "$work/e.tar.gz" -C "$work/empty" .
out="$(import "$work/e.tar.gz")"
expect "an empty archive is refused" "$out" '.ok == false and (.error.message | test("no files"))'
python3 - "$work/f.tar.gz" <<'PY'
import io, sys, tarfile
with tarfile.open(sys.argv[1], "w:gz") as t:
    for name in ("app.txt", "../../escape.txt"):
        data = b"x"
        info = tarfile.TarInfo(name)
        info.size = len(data)
        t.addfile(info, io.BytesIO(data))
PY
out="$(import "$work/f.tar.gz")"
expect "an archive reaching outside its folder is refused" "$out" '.ok == false'
[[ ! -e "$app/escape.txt" && ! -e /srv/apps/escape.txt && ! -e /srv/escape.txt ]] && pass "and nothing was written outside" || fail "a file escaped the import folder"
[[ "$(rows "$app/data/app.sqlite3")" == 42 ]] && pass "data/ is still the last good import (42 rows)" || fail "data changed: $(rows "$app/data/app.sqlite3")"
[[ -z "$(find "$app" -maxdepth 1 -name 'data.importing-*')" ]] && pass "no half-imported folders left" || fail "leftover import folders: $(find "$app" -maxdepth 1 -name 'data.importing-*')"

echo "Guards"
name="$(stage "$work/b.tar")"
chown root:root "$restore_dir/$name"
out="$(call data.import "{\"slug\":\"$slug\",\"file\":\"$name\"}")"
expect "a file the panel doesn't own is refused" "$out" '.ok == false and .error.code == "forbidden"'
ln -sf /etc/shadow "$restore_dir/$slug-20261030000000-5ca1ab1e.tar.gz"
out="$(call data.import "{\"slug\":\"$slug\",\"file\":\"$slug-20261030000000-5ca1ab1e.tar.gz\"}")"
expect "a symlink is refused" "$out" '.ok == false'

echo "Clean up"
rm -f "$restore_dir"/"$slug"-*
rm -rf "$work"
call app.delete "{\"slug\":\"$slug\",\"keepData\":false}" >/dev/null

if ((failures)); then echo "$failures check(s) failed"; exit 1; fi
echo "All import checks passed"

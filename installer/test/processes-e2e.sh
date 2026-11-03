#!/usr/bin/env bash
# Processes (PLAN-PROCESSES.md): workers as systemd services beside the app,
# and app.run, end to end through the agent. Run as root after install.sh
# (creates and deletes an app named proctest).
#   sudo bash installer/test/processes-e2e.sh
# SC2015: `[[ check ]] && pass || fail` is intended (pass never fails).
# shellcheck disable=SC2015
set -uo pipefail

sock=/run/layer/agent.sock
slug=proctest
app=/srv/apps/$slug
sha1=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1
sha2=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2
unit=app-$slug-worker-queue.service
node_version="$(find /opt/layer/node -mindepth 1 -maxdepth 1 -printf '%f\n' | sort -V | tail -1)"
failures=0

command -v socat >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q socat >/dev/null
pass() { printf '  \e[32m✓\e[0m %s\n' "$1"; }
fail() {
  printf '  \e[31m✗\e[0m %s\n' "$1"
  [[ -n "${2:-}" ]] && printf '%s\n' "$2" | head -20 | sed 's/^/      /'
  failures=$((failures + 1))
}
# raw <action> <params> [seconds]: every line the agent sends (chunks, then the result).
raw() {
  jq -nc --arg id "p$RANDOM" --arg a "$1" --argjson p "${2:-"{}"}" '{id: $id, action: $a, params: $p}' |
    runuser -u layer -- socat -t "${3:-120}" - "UNIX-CONNECT:$sock"
}
call() { raw "$@" | grep -av '"chunk"' | tail -1; }
expect() { if jq -e "$3" >/dev/null 2>&1 <<<"$2"; then pass "$1"; else fail "$1" "$2"; fi; }
# until_state <state> <unit>: waits up to 30s for systemd to report it.
until_state() {
  local _
  for _ in $(seq 1 30); do
    [[ "$(systemctl show -p ActiveState --value "$2")" == "$1" ]] && return 0
    sleep 1
  done
  return 1
}
worker() { jq -nc --arg n "$node_version" --arg name "$1" --arg file "$2" '{slug: "proctest", name: $name, nodeVersion: $n, exec: ["node", $file], memoryMaxMb: 256}'; }
release() {
  runuser -u "app-$slug" -- mkdir -p "$app/releases/$1"
  cat <<JS | runuser -u "app-$slug" -- tee "$app/releases/$1/worker.js" >/dev/null
const fs = require("node:fs");
console.log("worker $2 greeting=" + process.env.GREETING + " env=" + process.env.NODE_ENV + " user=" + require("node:os").userInfo().username);
try { fs.writeFileSync("/etc/worker-pwned", "x"); console.log("WROTE /etc"); } catch (e) { console.log("etc blocked " + e.code); }
fs.writeFileSync(process.env.DATA_DIR + "/worker.txt", "$2");
setInterval(() => {}, 1000);
JS
  printf 'console.error("crashing on purpose"); process.exit(3);\n' | runuser -u "app-$slug" -- tee "$app/releases/$1/crash.js" >/dev/null
  printf 'console.log("ran " + process.argv[2] + " as " + require("node:os").userInfo().username + " in " + process.cwd()); process.exit(Number(process.argv[3] || 0));\n' |
    runuser -u "app-$slug" -- tee "$app/releases/$1/task.js" >/dev/null
  printf 'setTimeout(() => {}, 120000);\n' | runuser -u "app-$slug" -- tee "$app/releases/$1/slow.js" >/dev/null
}
# go_live <sha> <color>: as a deploy leaves it (each deploy switches color, which moves current).
go_live() {
  call release.point "{\"slug\":\"$slug\",\"color\":\"$2\",\"sha\":\"$1\"}" >/dev/null
  call proxy.set "{\"slug\":\"$slug\",\"color\":\"$2\",\"domains\":[\"$slug.internal\"]}" >/dev/null
}

call app.delete "{\"slug\":\"$slug\",\"keepData\":false}" >/dev/null

echo "Setup"
call app.create "{\"slug\":\"$slug\"}" >/dev/null
call env.write "{\"slug\":\"$slug\",\"vars\":{\"GREETING\":\"hello from a worker\"}}" >/dev/null
release "$sha1" v1
release "$sha2" v2

echo "A worker before the first deploy"
expect "worker.write writes it but doesn't start it" "$(call worker.write "$(worker queue worker.js)")" '.ok and .result.started == false'
[[ "$(systemctl is-enabled "$unit")" == enabled ]] && pass "  it's enabled, so it starts at boot" || fail "not enabled"

echo "Running"
go_live "$sha1" blue
expect "worker.write starts it once the app is live" "$(call worker.write "$(worker queue worker.js)")" '.result.started == true'
until_state active "$unit" && pass "  systemd says it's running" || fail "not running" "$(systemctl status "$unit" --no-pager 2>&1)"
sleep 2
log="$(journalctl -u "$unit" --no-pager -o cat 2>&1)"
grep -q "worker v1 greeting=hello from a worker env=production user=app-$slug" <<<"$log" && pass "  as the app's user, with its env vars and NODE_ENV=production" || fail "env or user" "$log"
grep -q "etc blocked EROFS" <<<"$log" && pass "  in the app's sandbox (it can't write /etc)" || fail "sandbox" "$log"
[[ ! -e /etc/worker-pwned ]] || fail "/etc/worker-pwned exists"
[[ "$(cat "$app/data/worker.txt" 2>/dev/null)" == v1 ]] && pass "  and it writes DATA_DIR" || fail "data/worker.txt"
pid="$(systemctl show -p MainPID --value "$unit")"
[[ "$(readlink "/proc/$pid/cwd")" == "$app/releases/$sha1" ]] && pass "  from the live release" || fail "cwd" "$(readlink "/proc/$pid/cwd")"
logs="$(raw logs.tail "{\"slug\":\"$slug\",\"lines\":50}" | tail -1)"
expect "the project's logs include the worker's lines" "$logs" '.result.lines | any(contains("app-proctest-worker-queue") and contains("worker v1"))'
list="$(call worker.list "{\"slug\":\"$slug\"}")"
expect "worker.list: running, with its memory" "$list" '.result.workers[0] | .name == "queue" and .state == "active" and .memoryBytes > 0 and (.since | length > 0)'

echo "A deploy"
go_live "$sha2" green
call worker.write "$(worker queue worker.js)" >/dev/null
until_state active "$unit"
sleep 2
pid="$(systemctl show -p MainPID --value "$unit")"
[[ "$(readlink "/proc/$pid/cwd")" == "$app/releases/$sha2" ]] && pass "rewriting it restarts it on the new release" || fail "still on the old release" "$(readlink "/proc/$pid/cwd")"
[[ "$(cat "$app/data/worker.txt")" == v2 ]] && pass "  running the new code" || fail "old code"

echo "Stop, start, restart"
call worker.control "{\"slug\":\"$slug\",\"name\":\"queue\",\"action\":\"stop\"}" >/dev/null
until_state inactive "$unit" && pass "stop stops it" || fail "stop"
call worker.control "{\"slug\":\"$slug\",\"name\":\"queue\",\"action\":\"start\"}" >/dev/null
until_state active "$unit" && pass "start starts it" || fail "start"
before="$(systemctl show -p MainPID --value "$unit")"
call worker.control "{\"slug\":\"$slug\",\"name\":\"queue\",\"action\":\"restart\"}" >/dev/null
until_state active "$unit"
[[ "$(systemctl show -p MainPID --value "$unit")" != "$before" ]] && pass "restart gives it a new process" || fail "restart"
kill -9 "$(systemctl show -p MainPID --value "$unit")"
sleep 4
until_state active "$unit" && pass "killed, it comes back by itself" || fail "no restart after a kill"

echo "A worker that keeps crashing"
call worker.write "$(worker crashy crash.js)" >/dev/null
until_state failed "app-$slug-worker-crashy.service" && pass "it stops after 5 tries in a minute" || fail "still restarting" "$(systemctl status "app-$slug-worker-crashy.service" --no-pager 2>&1)"
list="$(call worker.list "{\"slug\":\"$slug\"}")"
expect "  worker.list says so: failed after 5 restarts, with its exit code" "$list" '.result.workers[] | select(.name == "crashy") | .state == "failed" and .restarts == 5 and .exitStatus == 3'
call worker.control "{\"slug\":\"$slug\",\"name\":\"crashy\",\"action\":\"start\"}" >/dev/null
sleep 1
[[ "$(systemctl show -p NRestarts --value "app-$slug-worker-crashy.service")" -lt 5 ]] && pass "  start clears the limit for another try" || fail "start after failure"

echo "Run a command"
out="$(raw app.run "$(jq -nc --arg n "$node_version" '{slug: "proctest", nodeVersion: $n, exec: ["node", "task.js", "migrate"]}')")"
expect "app.run returns exit code 0" "$(tail -1 <<<"$out")" '.ok and .result.code == 0'
grep -q "ran migrate as app-$slug in $app/releases/$sha2" <<<"$out" && pass "  its output streams back: as the app, in the live release" || fail "output" "$out"
out="$(raw app.run "$(jq -nc --arg n "$node_version" '{slug: "proctest", nodeVersion: $n, exec: ["node", "task.js", "x", "3"]}')" | tail -1)"
expect "a failing command reports its exit code" "$out" '.ok and .result.code == 3'
expect "anything but node, npm or npx is refused" "$(call app.run "$(jq -nc --arg n "$node_version" '{slug: "proctest", nodeVersion: $n, exec: ["bash", "-c", "id"]}')")" '.error.code == "invalid_params"'
raw app.run "$(jq -nc --arg n "$node_version" '{slug: "proctest", nodeVersion: $n, exec: ["node", "slow.js"]}')" 3 >/dev/null
gone=no
for _ in $(seq 1 15); do
  systemctl is-active --quiet "layer-run-$slug.service" || { gone=yes; break; }
  sleep 1
done
[[ "$gone" == yes ]] && pass "a command stops when its caller goes away" || fail "layer-run-$slug still running"

echo "Cleanup"
expect "worker.delete removes a worker" "$(call worker.delete "{\"slug\":\"$slug\",\"name\":\"crashy\"}")" '.ok'
[[ ! -e "/etc/systemd/system/app-$slug-worker-crashy.service" ]] && pass "  and its unit file" || fail "crashy unit left"
call app.delete "{\"slug\":\"$slug\",\"keepData\":false}" >/dev/null
[[ ! -e "/etc/systemd/system/$unit" ]] && ! systemctl is-active --quiet "$unit" && pass "app.delete stops and removes the app's workers" || fail "worker left after app.delete"

echo
if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "All processes checks passed"

#!/usr/bin/env bash
# Week 3 Day 3: cron jobs as systemd timers, end to end through the agent.
# Run as root after install.sh (creates and deletes an app named crontest).
#   sudo bash installer/test/cron-e2e.sh
# SC2015: `[[ check ]] && pass || fail` is intended (pass never fails).
# shellcheck disable=SC2015
set -uo pipefail

sock=/run/layer/agent.sock
slug=crontest
app=/srv/apps/$slug
sha=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
node_version="$(find /opt/layer/node -mindepth 1 -maxdepth 1 -printf '%f\n' | sort -V | tail -1)"
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
    runuser -u layer -- socat -t 120 - "UNIX-CONNECT:$sock" | grep -av '"chunk"' | tail -1
}
expect() { if jq -e "$3" >/dev/null 2>&1 <<<"$2"; then pass "$1"; else fail "$1" "$2"; fi; }
# history_until <job> <jq filter on .result.runs>: polls cron.history until the filter holds (max 90s).
history_until() {
  local out="" _
  for _ in $(seq 1 45); do
    out="$(call cron.history "{\"slug\":\"$slug\",\"name\":\"$1\"}")"
    jq -e ".result.runs | $2" >/dev/null 2>&1 <<<"$out" && break
    sleep 2
  done
  printf '%s' "$out"
}

call app.delete "{\"slug\":\"$slug\",\"keepData\":false}" >/dev/null

echo "Converter output is valid systemd"
# Every calendar the panel's cron converter produces in its unit tests.
for cal in "*-*-* *:*:00" "*-*-* *:00/15:00" "*-*-* 03:30:00" "*-*-* 09..17:00:00" "*-*-* 09..17/2:00:00" \
  "*-*-* *:00,30:00" "*-*-01 00:00:00" "*-01-01 00:00:00" "Mon..Fri *-*-* 08:00:00" "Mon,Wed,Fri *-*-* 08:00:00" \
  "Sun *-*-* 10:00:00" daily hourly weekly; do
  systemd-analyze calendar --iterations=1 "$cal" >/dev/null 2>&1 || fail "systemd rejects \"$cal\""
done
pass "systemd-analyze accepts all 14 converted calendars"

echo "Setup"
call app.create "{\"slug\":\"$slug\"}" >/dev/null
runuser -u "app-$slug" -- mkdir -p "$app/releases/$sha"
cat <<'JS' | runuser -u "app-$slug" -- tee "$app/releases/$sha/job.js" >/dev/null
const fs = require("node:fs");
console.log(`run greeting=${process.env.GREETING} user=${require("node:os").userInfo().username}`);
fs.appendFileSync("/srv/apps/crontest/data/runs.txt", new Date().toISOString() + "\n");
try {
  fs.writeFileSync("/etc/cron-pwned", "x");
  console.log("WROTE /etc");
} catch (e) {
  console.log(`etc blocked ${e.code}`);
}
if (process.argv[2] === "fail") {
  console.error("failing on purpose");
  process.exit(3);
}
JS
call env.write "{\"slug\":\"$slug\",\"vars\":{\"GREETING\":\"hello from cron\"}}" >/dev/null
call release.point "{\"slug\":\"$slug\",\"color\":\"blue\",\"sha\":\"$sha\"}" >/dev/null
call proxy.set "{\"slug\":\"$slug\",\"color\":\"blue\",\"domains\":[\"$slug.internal\"]}" >/dev/null
[[ "$(readlink "$app/current")" == "releases/$sha" ]] && pass "proxy.set points current at the live release" || fail "current symlink" "$(ls -l "$app")"

echo "A job every minute"
res="$(call cron.write "$(jq -nc --arg n "$node_version" '{slug: "crontest", name: "tick", calendar: "*-*-* *:*:00", nodeVersion: $n, exec: ["node", "job.js"]}')")"
expect "cron.write creates the timer (next run: $(jq -r '.result.nextRun' <<<"$res"))" "$res" '.ok and (.result.nextRun | length > 0)'
systemctl list-timers --all --no-legend | grep -q "app-$slug-cron-tick.timer" && pass "visible in systemctl list-timers" || fail "list-timers"
call cron.run "{\"slug\":\"$slug\",\"name\":\"tick\"}" >/dev/null
out="$(history_until tick 'any(.status == "success")')"
expect "cron.run: the run succeeds" "$out" '.result.runs | any(.status == "success" and .exitStatus == 0)'
expect "  as the app user, with its env vars" "$out" '[.result.runs[].output[]] | any(contains("greeting=hello from cron user=app-crontest"))'
expect "  and it can't write /etc" "$out" '[.result.runs[].output[]] | any(contains("etc blocked EROFS"))'
[[ ! -e /etc/cron-pwned ]] || fail "/etc/cron-pwned exists"
out="$(history_until tick '[.[] | select(.status == "success")] | length >= 2')"
expect "the timer fires on its own within a minute" "$out" '[.result.runs[] | select(.status == "success")] | length >= 2'

echo "A failing job"
call cron.write "$(jq -nc --arg n "$node_version" '{slug: "crontest", name: "broken", calendar: "daily", nodeVersion: $n, exec: ["node", "job.js", "fail"]}')" >/dev/null
call cron.run "{\"slug\":\"$slug\",\"name\":\"broken\"}" >/dev/null
out="$(history_until broken 'any(.status == "failed")')"
expect "it shows as failed with exit code 3" "$out" '.result.runs[0].status == "failed" and .result.runs[0].exitStatus == 3'
expect "  with its error output" "$out" '.result.runs[0].output | any(contains("failing on purpose"))'
list="$(call cron.list "{\"slug\":\"$slug\"}")"
expect "cron.list shows both jobs with schedule, next run and last result" "$list" \
  '(.result.jobs | map(.name) | sort) == ["broken","tick"] and (.result.jobs[] | select(.name == "broken") | .lastResult == "exit-code") and (.result.jobs[] | select(.name == "tick") | .calendar == "*-*-* *:*:00" and (.nextRun | length > 0))'

echo "Validation and cleanup"
expect "an invalid schedule is refused by systemd" \
  "$(call cron.write "$(jq -nc --arg n "$node_version" '{slug: "crontest", name: "bad", calendar: "*-*-* 25:00:00", nodeVersion: $n, exec: ["node", "job.js"]}')")" \
  '.error.code == "invalid_schedule"'
expect "cron.delete removes a job" "$(call cron.delete "{\"slug\":\"$slug\",\"name\":\"tick\"}")" '.ok'
systemctl list-timers --all --no-legend | grep -q "app-$slug-cron-tick" && fail "the tick timer still exists" || pass "  and its timer is gone"
call app.delete "{\"slug\":\"$slug\",\"keepData\":false}" >/dev/null
[[ ! -e "/etc/systemd/system/app-$slug-cron-broken.timer" ]] && pass "app.delete removes the app's remaining cron jobs" || fail "cron units left after app.delete"

echo
if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "All cron checks passed"

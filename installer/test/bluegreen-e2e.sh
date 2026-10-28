#!/usr/bin/env bash
# Day 4 "done when": an app goes blue → green (and back) under constant
# HTTPS traffic through Caddy without a single failed request. Also covers a
# release that never gets healthy, logs, the score and the layer CLI.
# Run as root after install.sh and the agent are installed.
#   sudo bash installer/test/bluegreen-e2e.sh
set -uo pipefail

sock=/run/layer/agent.sock
node_version="${LAYER_NODE_DEFAULT:-24.13.1}"
slug=hello
domain=hello.internal
app=/srv/apps/$slug
work="$(mktemp -d)"
failures=0
n=0

command -v socat >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q socat >/dev/null

pass() { printf '  \e[32m✓\e[0m %s\n' "$1"; }
fail() {
  printf '  \e[31m✗\e[0m %s\n' "$1"
  [[ -n "${2:-}" ]] && printf '      %s\n' "$2"
  failures=$((failures + 1))
}
call() {
  local params="${2:-}"
  [[ -n "$params" ]] || params='{}'
  n=$((n + 1))
  jq -nc --arg id "bg$n" --arg a "$1" --argjson p "$params" '{id: $id, action: $a, params: $p}' |
    runuser -u layer -- socat -t 600 - "UNIX-CONNECT:$sock"
}
expect() { if jq -e "$3" >/dev/null 2>&1 <<<"$2"; then pass "$1"; else fail "$1" "$2"; fi; }
get() { curl -sk --max-time 5 --resolve "$domain:443:127.0.0.1" "https://$domain${1:-/}"; }
# The first request to a brand-new site can beat its certificate (Caddy issues
# it right after the reload), so wait up to 10s for an expected answer.
get_eventually() {
  local want="$1" got="" _
  for _ in $(seq 1 20); do
    got="$(get)"
    [[ "$got" == "$want" ]] && break
    sleep 0.5
  done
  printf '%s' "$got"
}

# A tiny release: answers its version and logs each request.
make_release() {
  local sha="$1" body="$2"
  mkdir -p "$app/releases/$sha"
  cat >"$app/releases/$sha/server.js" <<JS
$body
JS
  chown -R "app-$slug:app-$slug" "$app/releases/$sha"
}
http_release() {
  make_release "$1" "require('node:http').createServer((req, res) => {
  console.log(req.method + ' ' + req.url);
  res.end('$2');
}).listen(process.env.PORT, process.env.HOSTNAME);"
}

# Background HTTPS traffic: one request every 20ms, each a fresh connection.
start_traffic() {
  : >"$work/traffic"
  touch "$work/running"
  (
    while [[ -e "$work/running" ]]; do
      printf '%s\n' "$(curl -sk --max-time 5 -o - -w ' %{http_code}' --resolve "$domain:443:127.0.0.1" "https://$domain/")" >>"$work/traffic"
      sleep 0.02
    done
  ) &
  traffic_pid=$!
  sleep 2
}
stop_traffic() {
  sleep 2
  rm -f "$work/running"
  wait "$traffic_pid"
}
# check_traffic <from> <to>: every request succeeded, and once <to> appeared
# <from> never came back.
check_traffic() {
  local total bad
  total="$(wc -l <"$work/traffic")"
  bad="$(grep -cvE "^($1|$2) 200$" "$work/traffic")"
  if ((bad == 0 && total > 50)); then
    pass "$total requests during $1 → $2, 0 failed"
  else
    fail "$total requests during $1 → $2, $bad failed" "$(grep -vE "^($1|$2) 200$" "$work/traffic" | sort | uniq -c | head -5)"
  fi
  if awk -v from="$1" -v to="$2" '$1 == to {seen = 1} seen && $1 == from {exit 1}' "$work/traffic"; then
    pass "traffic moved to $2 once and never back to $1"
  else
    fail "traffic moved to $2 once and never back to $1"
  fi
  grep -q "^$2 200$" "$work/traffic" || fail "saw $2 at all"
}

call app.delete "{\"slug\":\"$slug\",\"keepData\":false}" >/dev/null

echo "Setup"
expect "app.create $slug" "$(call app.create "{\"slug\":\"$slug\"}")" '.ok'
http_release aaaaaaa v1
http_release bbbbbbb v2
expect "unit.write (node server.js, 128MB)" \
  "$(call unit.write "{\"slug\":\"$slug\",\"nodeVersion\":\"$node_version\",\"exec\":[\"node\",\"server.js\"],\"memoryMaxMb\":128}")" '.ok'
expect "unit.start blue without a release → no_release" "$(call unit.start "{\"slug\":\"$slug\",\"color\":\"blue\"}")" \
  '.error.code == "no_release"'

echo "First deploy (blue)"
expect "release.point blue → v1" "$(call release.point "{\"slug\":\"$slug\",\"color\":\"blue\",\"sha\":\"aaaaaaa\"}")" '.ok'
expect "unit.start blue gets healthy" "$(call unit.start "{\"slug\":\"$slug\",\"color\":\"blue\"}")" '.ok and .result.healthy'
expect "proxy.set → blue" "$(call proxy.set "{\"slug\":\"$slug\",\"color\":\"blue\",\"domains\":[\"$domain\"]}")" '.ok'
expect "https://$domain serves v1 (once its certificate is issued)" "\"$(get_eventually v1)\"" '. == "v1"'

echo "Blue → green under traffic"
start_traffic
call release.point "{\"slug\":\"$slug\",\"color\":\"green\",\"sha\":\"bbbbbbb\"}" >"$work/r1"
call unit.start "{\"slug\":\"$slug\",\"color\":\"green\"}" >"$work/r2"
call proxy.set "{\"slug\":\"$slug\",\"color\":\"green\",\"domains\":[\"$domain\"]}" >"$work/r3"
sleep 2 # let requests in flight on blue finish before stopping it
call unit.stop "{\"slug\":\"$slug\",\"color\":\"blue\"}" >"$work/r4"
stop_traffic
expect "deploy steps all ok" "$(jq -s . "$work"/r[1-4])" 'all(.ok)'
check_traffic v1 v2
status="$(call unit.status "{\"slug\":\"$slug\"}")"
expect "status: green live, active, enabled; blue inactive, disabled" "$status" \
  '.result.live == "green" and .result.green.state == "active" and .result.green.enabled and .result.blue.state == "inactive" and (.result.blue.enabled | not) and .result.green.release == "bbbbbbb"'
expect "can't stop the live color" "$(call unit.stop "{\"slug\":\"$slug\",\"color\":\"green\"}")" '.error.code == "conflict"'
expect "can't repoint the live color" "$(call release.point "{\"slug\":\"$slug\",\"color\":\"green\",\"sha\":\"aaaaaaa\"}")" '.error.code == "conflict"'

echo "Rollback green → blue under traffic"
start_traffic
call unit.start "{\"slug\":\"$slug\",\"color\":\"blue\"}" >"$work/r1"
call proxy.set "{\"slug\":\"$slug\",\"color\":\"blue\",\"domains\":[\"$domain\"]}" >"$work/r2"
sleep 2
call unit.stop "{\"slug\":\"$slug\",\"color\":\"green\"}" >"$work/r3"
stop_traffic
expect "rollback steps all ok" "$(jq -s . "$work"/r[1-3])" 'all(.ok)'
check_traffic v2 v1

echo "A release that never gets healthy"
make_release ccccccc "console.error('boom: missing DATABASE_URL'); process.exit(1);"
call release.point "{\"slug\":\"$slug\",\"color\":\"green\",\"sha\":\"ccccccc\"}" >/dev/null
expect "unit.start green fails with unhealthy" \
  "$(call unit.start "{\"slug\":\"$slug\",\"color\":\"green\",\"timeoutSec\":6}")" '.error.code == "unhealthy"'
expect "the broken color is stopped and disabled again" "$(call unit.status "{\"slug\":\"$slug\"}")" \
  '(.result.green.state == "inactive" or .result.green.state == "failed") and (.result.green.enabled | not)'
expect "the site still serves v1" "\"$(get)\"" '. == "v1"'
expect "its crash is in the logs" "$(call logs.tail "{\"slug\":\"$slug\",\"color\":\"green\",\"lines\":50}")" \
  '.result.lines | any(contains("boom: missing DATABASE_URL"))'

echo "Logs, score, CLI"
get /marker-one >/dev/null
expect "logs.tail has the request" "$(call logs.tail "{\"slug\":\"$slug\",\"color\":\"blue\",\"lines\":20}")" \
  '.result.lines | any(contains("GET /marker-one"))'
timeout 4 layer logs "$slug" -f -n 1 >"$work/follow" 2>&1 &
follow_pid=$!
sleep 1.5
get /marker-follow >/dev/null
wait "$follow_pid"
if grep -q "GET /marker-follow" "$work/follow"; then pass "layer logs -f streams new lines"; else fail "layer logs -f streams new lines" "$(cat "$work/follow")"; fi
score="$(call security.score "{\"slug\":\"$slug\",\"color\":\"blue\"}")"
expect "safety score below 3 ($(jq -r '.result.score' <<<"$score"))" "$score" '.result.score < 3'
if layer ps | grep -qE "^$slug +blue"; then pass "layer ps shows $slug live on blue"; else fail "layer ps shows $slug live on blue" "$(layer ps)"; fi
if layer status "$slug" | grep -q "aaaaaaa"; then pass "layer status shows the release"; else fail "layer status shows the release"; fi
if systemctl is-enabled --quiet "app-$slug@blue"; then pass "live color starts on boot (enabled)"; else fail "live color starts on boot (enabled)"; fi

echo "Delete"
expect "app.delete $slug" "$(call app.delete "{\"slug\":\"$slug\",\"keepData\":false}")" '.ok'
if [[ ! -e "/etc/caddy/sites/$slug.caddy" && ! -e "/etc/systemd/system/app-$slug@.service" ]]; then
  pass "site and unit files are gone"
else
  fail "site and unit files are gone"
fi
if [[ "$(get)" == v1 ]]; then fail "https://$domain no longer serves"; else pass "https://$domain no longer serves"; fi

rm -rf "$work"
echo
if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "All blue/green checks passed"

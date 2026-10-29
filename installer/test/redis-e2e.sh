#!/usr/bin/env bash
# Week 4 Day 4: a Redis per app, end to end through the agent.
# Run as root after install.sh (creates and deletes apps rdsa and rdsb).
#   sudo bash installer/test/redis-e2e.sh
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
# rcli <port> <password> <command…>: one command, as the server answers it.
rcli() {
  local port="$1" pw="$2"
  shift 2
  REDISCLI_AUTH="$pw" "$cli" --no-auth-warning -h 127.0.0.1 -p "$port" "$@" 2>&1
}

for s in rdsa rdsb; do call app.delete "{\"slug\":\"$s\",\"keepData\":false}" >/dev/null; done

echo "Install"
out="$(call service.install '{"name":"redis"}')"
expect "service.install redis" "$out" '.ok == true'
cli="$(command -v redis-cli || command -v valkey-cli)"
[[ -n "$cli" ]] && pass "client installed ($cli)" || fail "no redis-cli/valkey-cli"
for unit in redis-server valkey-server; do
  state="$(systemctl is-enabled "$unit" 2>/dev/null)"
  [[ -z "$state" || "$state" == masked ]] || fail "the shared $unit is $state (should be masked)"
done
pass "the package's shared instance is masked"

echo "One Redis per app"
for s in rdsa rdsb; do
  call app.create "{\"slug\":\"$s\"}" >/dev/null
  out="$(call redis.add "{\"slug\":\"$s\",\"memoryMb\":32}")"
  expect "redis.add $s" "$out" '.ok == true'
done
read -r pa pwa < <(jq -r '.redis | "\(.port) \(.password)"' /etc/layer/apps/rdsa/services.json)
read -r pb pwb < <(jq -r '.redis | "\(.port) \(.password)"' /etc/layer/apps/rdsb/services.json)
[[ "$pa" != "$pb" && "$pwa" != "$pwb" ]] && pass "own ports ($pa, $pb) and passwords" || fail "shared port or password"
[[ "$(rcli "$pa" "$pwa" PING)" == PONG ]] && pass "rdsa's password works on rdsa's Redis" || fail "PING rdsa" "$(rcli "$pa" "$pwa" PING)"
[[ "$(rcli "$pb" "$pwa" PING)" == *WRONGPASS* || "$(rcli "$pb" "$pwa" PING)" == *invalid* ]] && pass "rdsa's password doesn't work on rdsb's Redis" || fail "cross-app auth" "$(rcli "$pb" "$pwa" PING)"
[[ "$(rcli "$pa" "" PING)" == *NOAUTH* ]] && pass "no password, no access" || fail "unauthenticated access" "$(rcli "$pa" "" PING)"
rcli "$pa" "$pwa" CONFIG SET dir /etc | grep -qiE "protected|ERR" && pass "CONFIG SET dir is refused" || fail "CONFIG SET dir allowed"
[[ "$(ss -ltnH "sport = :$pa" | awk '{print $4}')" == "127.0.0.1:$pa" ]] && pass "listens on 127.0.0.1 only" || fail "listen address" "$(ss -ltn "sport = :$pa")"
[[ "$(ps -o user= -p "$(systemctl show -p MainPID --value layer-redis-rdsa.service)")" == app-rdsa ]] && pass "runs as app-rdsa" || fail "wrong user"
score="$(systemd-analyze security layer-redis-rdsa.service 2>/dev/null | grep -oE 'level for [^:]+: [0-9.]+' | grep -oE '[0-9.]+$')"
pass "safety score $score"

echo "Env and files"
grep -q "^REDIS_URL=\"redis://default:$pwa@127.0.0.1:$pa\"$" /etc/layer/apps/rdsa/services.env && pass "services.env has REDIS_URL" || fail "services.env" "$(cat /etc/layer/apps/rdsa/services.env)"
[[ "$(stat -c '%U %a' /etc/layer/apps/rdsa/services.env)" == "root 600" ]] && pass "services.env is root 600" || fail "services.env mode"
[[ "$(stat -c '%U %a' /etc/layer/apps/rdsa/redis.conf)" == "root 600" ]] && pass "redis.conf is root 600 (Redis gets it on stdin)" || fail "redis.conf mode $(stat -c '%U %a' /etc/layer/apps/rdsa/redis.conf)"
runuser -u app-rdsa -- cat /etc/layer/apps/rdsa/redis.conf >/dev/null 2>&1 && fail "the app can read its redis.conf" || pass "not even the app's own user can read the config"

echo "Data survives a restart, and lands in data/redis"
rcli "$pa" "$pwa" SET greeting hello >/dev/null
rcli "$pa" "$pwa" SAVE >/dev/null
systemctl restart layer-redis-rdsa.service
for _ in $(seq 1 20); do [[ "$(rcli "$pa" "$pwa" PING)" == PONG ]] && break; sleep 0.25; done
[[ "$(rcli "$pa" "$pwa" GET greeting)" == hello ]] && pass "the key is back after a restart" || fail "data lost"
[[ -f /srv/apps/rdsa/data/redis/dump.rdb ]] && pass "dump.rdb is in data/redis (so it's backed up)" || fail "no dump.rdb"
out="$(call service.status '{"slug":"rdsa"}')"
expect "service.status shows it answering" "$out" '.result.redis.answering == true and .result.redis.active == true'

echo "Remove"
out="$(call redis.remove '{"slug":"rdsb"}')"
expect "redis.remove" "$out" '.ok == true'
systemctl is-active -q layer-redis-rdsb.service && fail "rdsb's Redis still runs" || pass "stopped"
grep -q REDIS_URL /etc/layer/apps/rdsb/services.env && fail "REDIS_URL still in services.env" || pass "REDIS_URL gone from services.env"
call app.delete '{"slug":"rdsa","keepData":false}' >/dev/null
[[ -f /etc/systemd/system/layer-redis-rdsa.service ]] && fail "app.delete left rdsa's Redis unit" || pass "app.delete removes the app's Redis too"
call app.delete '{"slug":"rdsb","keepData":false}' >/dev/null

if ((failures)); then echo "$failures check(s) failed"; exit 1; fi
echo "All Redis checks passed"

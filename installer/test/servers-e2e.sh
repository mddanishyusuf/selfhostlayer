#!/usr/bin/env bash
# Servers, Day 1: this server's panel reaching another server's agent over the
# link (PLAN-SERVERS.md). Run as root on the panel's server, after the other
# one ran install.sh --agent-only --panel-key <this panel's key>:
#   sudo bash installer/test/servers-e2e.sh <other server's IP>
# SC2015: `[[ check ]] && pass || fail` is intended (pass never fails).
# shellcheck disable=SC2015
set -uo pipefail
other="${1:?the IP of the other server}"
key=/var/lib/layer/ssh/id_ed25519
failures=0
pass() { printf '  \e[32m✓\e[0m %s\n' "$1"; }
fail() {
  printf '  \e[31m✗\e[0m %s\n' "$1"
  [[ -n "${2:-}" ]] && printf '%s\n' "$2" | head -10 | sed 's/^/      /'
  failures=$((failures + 1))
}
# ssh as the panel does: its key, its known_hosts, nothing else.
link() { runuser -u layer -- ssh -F /dev/null -T -i "$key" -o BatchMode=yes -o IdentitiesOnly=yes -o UserKnownHostsFile=/var/lib/layer/ssh/known_hosts-test -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "$@"; }

echo "The panel's key"
[[ -f "$key" ]] || runuser -u layer -- bash -c "mkdir -p -m 700 /var/lib/layer/ssh && ssh-keygen -q -t ed25519 -N '' -C layer-panel -f $key"
[[ "$(stat -c '%U %a' "$key")" == "layer 600" ]] && pass "the panel's private key is the panel's alone" || fail "key: $(stat -c '%U %a' "$key")"

echo "A call over the link"
out="$(printf '{"id":"e2e1","action":"system.info","params":{}}\n' | link "layer-link@$other" | head -1)"
jq -e '.ok == true and .result.agentOnly == true' <<<"$out" >/dev/null && pass "system.info from the other server's agent (agent-only)" || fail "system.info over the link" "$out"
ip="$(jq -r '.result.publicIp' <<<"$out")"
pass "it says its address is $ip, its free addresses <app>.$(jq -r '.result.appsDomain' <<<"$out")"

echo "Nothing else over that key"
out="$(link "layer-link@$other" id </dev/null 2>&1 | head -3)"
grep -q "uid=" <<<"$out" && fail "the key ran a command" "$out" || pass "a command is ignored: the key only reaches the agent"
out="$(timeout 15 runuser -u layer -- ssh -F /dev/null -tt -i "$key" -o BatchMode=yes -o UserKnownHostsFile=/var/lib/layer/ssh/known_hosts-test "layer-link@$other" </dev/null 2>&1 | head -3)"
grep -qE '\$ |# |uid=' <<<"$out" && fail "a terminal opened" "$out" || pass "no terminal"
out="$(link -W 127.0.0.1:22 "layer-link@$other" </dev/null 2>&1 | head -3)"
grep -q "SSH-2.0" <<<"$out" && fail "stdio forwarding works" "$out" || pass "no forwarding (stdio)"
link -N -o ExitOnForwardFailure=yes -L 127.0.0.1:2299:127.0.0.1:22 "layer-link@$other" </dev/null >/dev/null 2>&1 &
sleep 3
timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/2299 && head -c 20 <&3' 2>/dev/null | grep -q SSH && fail "port forwarding works" || pass "no forwarding (ports)"
kill %1 2>/dev/null

echo "The other server keeps its own record"
out="$(printf '{"id":"e2e2","action":"audit.tail","params":{"limit":20}}\n' | link "layer-link@$other" | head -1)"
jq -e '.ok == true' <<<"$out" >/dev/null && pass "its agent answers audit.tail over the link" || fail "audit.tail" "$out"

if ((failures)); then echo "$failures check(s) failed"; exit 1; fi
echo "All server checks passed"

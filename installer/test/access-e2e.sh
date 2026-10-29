#!/usr/bin/env bash
# Weeks 5-6 Day 3: locking the panel to some addresses (panel.access) and
# getting back in with `layer access reset`, checked through Caddy.
# Run as root after install.sh.
#   sudo bash installer/test/access-e2e.sh
# SC2015: `[[ check ]] && pass || fail` is intended (pass never fails).
# shellcheck disable=SC2015
set -uo pipefail

host="$(jq -r .panelHost /etc/layer/config.json)"
blocked="This panel only answers from allowed addresses."
failures=0

pass() { printf '  \e[32m✓\e[0m %s\n' "$1"; }
fail() {
  printf '  \e[31m✗\e[0m %s\n' "$1"
  [[ -n "${2:-}" ]] && printf '%s\n' "$2" | head -20 | sed 's/^/      /'
  failures=$((failures + 1))
}
expect() { if jq -e "$3" >/dev/null 2>&1 <<<"$2"; then pass "$1"; else fail "$1" "$2"; fi; }
# code: the status Caddy answers for a request from this box (127.0.0.1).
code() { curl -sk -o /dev/null -w '%{http_code}' --resolve "$host:443:127.0.0.1" "https://$host/api/health"; }
body() { curl -sk --resolve "$host:443:127.0.0.1" "https://$host${1:-/api/health}" "${@:2}"; }
# Caddy reloads in the background: wait for the answer to change.
settle() { for _ in $(seq 1 30); do [[ "$(code)" == "$1" ]] && return 0; sleep 0.5; done; return 1; }

echo "Anyone, to start"
layer access | grep -q "anyone can reach" && pass "layer access: anyone can reach the sign-in page" || fail "layer access" "$(layer access 2>&1)"
[[ "$(code)" == 200 ]] && pass "the panel answers" || fail "the panel answers $(code)"

echo "Only an address these requests don't come from"
out="$(layer call panel.access '{"allow":["203.0.113.7"]}' 2>&1)"
expect "panel.access took the list" "$out" '.allow == ["203.0.113.7"]'
settle 403 && pass "requests from elsewhere get a 403 from Caddy" || fail "the panel answers $(code)"
[[ "$(body)" == "$blocked" ]] && pass "with a plain explanation" || fail "body: $(body)"
hook="$(body /api/github/webhook -X POST -H 'Content-Type: application/json' -d '{}')"
[[ "$hook" != "$blocked" ]] && pass "GitHub's webhook still reaches the panel" || fail "the webhook is blocked too"
layer access | grep -q "203.0.113.7" && pass "layer access shows the list" || fail "layer access" "$(layer access 2>&1)"

echo "Getting back in from the server"
layer access reset | grep -q "Anyone can reach" && pass "layer access reset" || fail "layer access reset" "$(layer access reset 2>&1)"
settle 200 && pass "the panel answers again" || fail "the panel answers $(code)"

echo "Ranges"
out="$(layer call panel.access '{"allow":["10.0.0.0/8","127.0.0.0/8"]}' 2>&1)"
expect "two ranges" "$out" '.allow | length == 2'
settle 200 && pass "a range that holds this request lets it in" || fail "the panel answers $(code)"
out="$(layer call panel.access '{"allow":["not-an-ip"]}' 2>&1)"
grep -q "IP address" <<<"$out" && pass "an entry that isn't an address is refused" || fail "bad entry accepted" "$out"
[[ "$(jq -c .panelAllow /etc/layer/config.json)" == '["10.0.0.0/8","127.0.0.0/8"]' ]] && pass "and the list is unchanged" || fail "config: $(jq -c .panelAllow /etc/layer/config.json)"
layer access reset >/dev/null
settle 200 || fail "the panel doesn't answer after the last reset"

if ((failures)); then echo "$failures check(s) failed"; exit 1; fi
echo "All access checks passed"

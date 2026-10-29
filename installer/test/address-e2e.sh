#!/usr/bin/env bash
# Weeks 5-6 Day 2: moving the panel to another address and back, through the
# agent (panel.address, panel.site), checked with real requests through Caddy.
# Run as root after install.sh, on a test box (internal TLS).
#   sudo bash installer/test/address-e2e.sh [new-host]
# SC2015: `[[ check ]] && pass || fail` is intended (pass never fails).
# shellcheck disable=SC2015
set -uo pipefail

new="${1:-panel2.internal}"
config=/etc/layer/config.json
original="$(jq -r .panelHost "$config")"
failures=0

pass() { printf '  \e[32m✓\e[0m %s\n' "$1"; }
fail() {
  printf '  \e[31m✗\e[0m %s\n' "$1"
  [[ -n "${2:-}" ]] && printf '%s\n' "$2" | head -20 | sed 's/^/      /'
  failures=$((failures + 1))
}
expect() { if jq -e "$3" >/dev/null 2>&1 <<<"$2"; then pass "$1"; else fail "$1" "$2"; fi; }
# code <host> [path]: the HTTP status Caddy answers for host (redirects not followed).
code() { curl -sk -o /dev/null -w '%{http_code}' --resolve "$1:443:127.0.0.1" "https://$1${2:-/api/health}"; }
location() { curl -sk -o /dev/null -w '%{redirect_url}' --resolve "$1:443:127.0.0.1" "https://$1$2"; }
# Caddy issues local-CA certificates in the background: wait for a host to answer.
answers() { for _ in $(seq 1 30); do [[ "$(code "$1")" == "$2" ]] && return 0; sleep 1; done; return 1; }
call() { layer call "$@" 2>&1; }

echo "Answer on both addresses while moving"
out="$(call panel.address "{\"hosts\":[\"$original\",\"$new\"],\"redirects\":[]}")"
expect "panel.address accepted both" "$out" ".host == \"$original\" and .pending == [\"$new\"]"
answers "$new" 200 && pass "the panel answers on $new" || fail "$new answers $(code "$new")"
[[ "$(code "$original")" == 200 ]] && pass "and still on $original" || fail "$original answers $(code "$original")"

echo "Switch: the new address leads, the old one redirects"
out="$(call panel.address "{\"hosts\":[\"$new\"],\"redirects\":[\"$original\"]}")"
expect "panel.address switched" "$out" ".host == \"$new\" and .aliases == [\"$original\"]"
[[ "$(jq -r .panelHost "$config")" == "$new" ]] && pass "config.json names $new" || fail "config.json: $(jq -c . "$config")"
answers "$original" 301 && pass "$original redirects (301)" || fail "$original answers $(code "$original")"
[[ "$(location "$original" "/settings?x=1")" == "https://$new/settings?x=1" ]] && pass "keeping the path and query" || fail "redirects to $(location "$original" "/settings?x=1")"
[[ "$(stat -c '%U:%G %a' "$config")" == "root:layer 640" ]] && pass "config.json is still root:layer 640" || fail "config.json: $(stat -c '%U:%G %a' "$config")"

echo "What the installer does on a re-run keeps it"
out="$(call panel.site)"
expect "panel.site keeps the address and the redirect" "$out" ".host == \"$new\" and .aliases == [\"$original\"]"
[[ "$(code "$new")" == 200 && "$(code "$original")" == 301 ]] && pass "both still answer the same way" || fail "after panel.site: $new $(code "$new"), $original $(code "$original")"

echo "Guards"
out="$(call panel.address "{\"hosts\":[\"$new\"],\"redirects\":[\"$new\"]}")"
grep -q "both serve" <<<"$out" && pass "a host can't serve and redirect at once" || fail "clash accepted" "$out"
out="$(call panel.address '{"hosts":["evil.example.com\n}"],"redirects":[]}')"
grep -q "lowercase hostname" <<<"$out" && pass "a host that would break the Caddyfile is refused" || fail "bad host accepted" "$out"
[[ "$(jq -r .panelHost "$config")" == "$new" ]] && pass "and nothing changed" || fail "config changed after refusals"

echo "Move back"
out="$(call panel.address "{\"hosts\":[\"$original\"],\"redirects\":[]}")"
expect "back on $original" "$out" ".host == \"$original\" and .aliases == []"
answers "$original" 200 && pass "$original serves the panel again" || fail "$original answers $(code "$original")"

if ((failures)); then echo "$failures check(s) failed"; exit 1; fi
echo "All address checks passed"

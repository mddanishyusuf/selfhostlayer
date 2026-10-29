#!/usr/bin/env bash
# Weeks 5-6 Day 4: a one-click update from a release feed (update.check,
# update.start, layer update), with this release repacked as a newer version.
# Run as root after install.sh, with the release and installer it came from.
#   sudo bash installer/test/update-e2e.sh <layer-VERSION.tar.gz> <install.sh>
# SC2015: `[[ check ]] && pass || fail` is intended (pass never fails).
# shellcheck disable=SC2015
set -uo pipefail

tarball="${1:?usage: update-e2e.sh <tarball> <install.sh>}"
installer="${2:?usage: update-e2e.sh <tarball> <install.sh>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config=/etc/layer/config.json
current="$(jq -r .version "$config")"
next="$current-next"
failures=0

pass() { printf '  \e[32m✓\e[0m %s\n' "$1"; }
fail() {
  printf '  \e[31m✗\e[0m %s\n' "$1"
  [[ -n "${2:-}" ]] && printf '%s\n' "$2" | tail -20 | sed 's/^/      /'
  failures=$((failures + 1))
}

settings="$(jq -c '{panelHost, appsDomain, internalTls, panelAliases, panelAllow}' "$config")"

echo "A newer release in the feed"
bash "$here/release-feed.sh" start "$tarball" "$installer" "$next" >/dev/null
out="$(layer call update.check 2>&1)"
jq -e --arg v "$next" '.available == true and .latest.version == $v' >/dev/null 2>&1 <<<"$out" && pass "update.check offers $next" || fail "update.check" "$out"

echo "layer update"
out="$(layer update 2>&1)"
grep -q "Updated to $next" <<<"$out" && pass "layer update: $current → $next" || fail "layer update" "$out"
[[ "$(jq -r .version "$config")" == "$next" ]] && pass "config.json names $next" || fail "config.json version: $(jq -r .version "$config")"
[[ "$(readlink /opt/layer/current)" == "releases/$next" ]] && pass "/opt/layer/current points at it" || fail "current: $(readlink /opt/layer/current)"
systemctl is-active --quiet layer-agent layer-panel && pass "the agent and the panel run" || fail "services" "$(systemctl status layer-agent layer-panel --no-pager 2>&1)"
runuser -u caddy -- curl -fsS --unix-socket /run/layer-panel/panel.sock http://panel/api/health >/dev/null && pass "the panel answers" || fail "the panel doesn't answer"
after="$(jq -c '{panelHost, appsDomain, internalTls, panelAliases, panelAllow}' "$config")"
[[ "$after" == "$settings" ]] && pass "the box's settings survived the installer: $after" || fail "settings changed" "$settings → $after"

echo "A release with a wrong checksum"
bash "$here/release-feed.sh" start "$tarball" "$installer" "$next-bad" bad >/dev/null
out="$(layer update "$next-bad" 2>&1)"
grep -q "doesn't match the checksum" <<<"$out" && pass "refused: $(grep -o "the release.*installed" <<<"$out")" || fail "a bad checksum wasn't refused" "$out"
[[ "$(jq -r .version "$config")" == "$next" ]] && pass "and nothing changed" || fail "version changed to $(jq -r .version "$config")"

bash "$here/release-feed.sh" stop
if ((failures)); then echo "$failures check(s) failed"; exit 1; fi
echo "All update checks passed"

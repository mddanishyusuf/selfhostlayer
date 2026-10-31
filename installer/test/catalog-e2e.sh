#!/usr/bin/env bash
# The integrations catalog (catalog.list, catalog.fetch) against a catalog
# served on this box: a good tarball is checked and unpacked as the app's
# user; a wrong checksum or a tarball on another host is refused, and nothing
# is written.
# Run as root after install.sh, with the test app built by
# scripts/build-catalog.ts (creates and deletes app ctg; puts config.json back):
#   sudo bash installer/test/catalog-e2e.sh /path/to/hello-0.1.0.tar.gz
# SC2015: `[[ check ]] && pass || fail` is intended (pass never fails).
# shellcheck disable=SC2015
set -uo pipefail

tarball="${1:?usage: catalog-e2e.sh <hello-0.1.0.tar.gz>}"
sock=/run/layer/agent.sock
config=/etc/layer/config.json
saved=/root/config.json.catalog-e2e
dir=/srv/layer-test-catalog
unit=layer-test-catalog
base=http://127.0.0.1:4997
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
sum() { sha256sum "$1" | cut -d' ' -f1; }
releases() { find /srv/apps/ctg/releases -mindepth 1 -maxdepth 1 | wc -l; }
leftovers() { find /var/lib/layer-agent/catalog -mindepth 1 2>/dev/null | wc -l; }

cp "$config" "$saved"
cleanup() {
  systemctl stop "$unit" 2>/dev/null || true
  rm -rf "${dir:?}"
  install -m 640 -o root -g layer "$saved" "$config"
  rm -f "$saved"
  call app.delete '{"slug":"ctg","keepData":false}' >/dev/null
}
trap cleanup EXIT

good="$(sum "$tarball")"
manifest="$(tar -xzOf "$tarball" hello-0.1.0/layer.json)"
mkdir -p "$dir/catalog/hello/0.1.0"
cp "$tarball" "$dir/catalog/hello/0.1.0/hello-0.1.0.tar.gz"
# write_catalog <sha256> [tarball url]
write_catalog() {
  jq -n --argjson m "$manifest" --arg s "$1" --arg u "${2:-$base/catalog/hello/0.1.0/hello-0.1.0.tar.gz}" \
    '{apps: [{id: "hello", versions: [{version: "0.1.0", date: "2026-11-01", notes: "Test.", tarball: {url: $u, sha256: $s}, manifest: $m}]}]}' >"$dir/catalog.json"
}
write_catalog "$good"
systemctl stop "$unit" 2>/dev/null || true
systemctl reset-failed "$unit" 2>/dev/null || true
systemd-run --quiet --unit="$unit" --property=DynamicUser=yes /usr/bin/python3 -m http.server 4997 --bind 127.0.0.1 --directory "$dir"
for _ in $(seq 1 20); do curl -fsS "$base/catalog.json" >/dev/null 2>&1 && break; sleep 0.5; done
jq --arg u "$base/catalog.json" '.catalogUrl = $u' "$saved" >"$config.new"
install -m 640 -o root -g layer "$config.new" "$config"
rm -f "$config.new"

call app.delete '{"slug":"ctg","keepData":false}' >/dev/null
call app.create '{"slug":"ctg"}' >/dev/null
release="${good:0:40}"
rel="/srv/apps/ctg/releases/$release"

echo "The catalog"
r="$(call catalog.list)"
expect "lists hello 0.1.0 with its manifest, but not where the tarball is" "$r" '.ok and .result.apps[0].id == "hello" and .result.apps[0].versions[0].manifest.runtime.health == "/healthz" and (tostring | contains("tar.gz") | not)'

echo "A good tarball"
r="$(call catalog.fetch '{"slug":"ctg","app":"hello","version":"0.1.0"}')"
expect "is checked and unpacked, named by its checksum" "$r" ".ok and .result.fetched == true and .result.release == \"$release\""
[[ -f "$rel/server.js" && -f "$rel/layer.json" ]] && pass "the release holds the app and its manifest" || fail "the release holds the app and its manifest" "$(ls -la "$rel" 2>&1)"
[[ "$(stat -c %U "$rel/server.js")" == app-ctg ]] && pass "its files belong to the app's user" || fail "its files belong to the app's user" "$(stat -c %U "$rel/server.js" 2>&1)"
[[ "$(leftovers)" == 0 ]] && pass "no download is left behind" || fail "no download is left behind" "$(ls -la /var/lib/layer-agent/catalog)"
r="$(call catalog.fetch '{"slug":"ctg","app":"hello","version":"0.1.0"}')"
expect "is fetched only once" "$r" '.ok and .result.fetched == false'

echo "Refused, with nothing written"
before="$(releases)"
write_catalog "$(printf '0%.0s' {1..64})"
r="$(call catalog.fetch '{"slug":"ctg","app":"hello","version":"0.1.0"}')"
expect "a tarball that doesn't match its checksum" "$r" '(.ok | not) and .error.code == "checksum_mismatch"'
[[ "$(releases)" == "$before" && "$(leftovers)" == 0 ]] && pass "  nothing was written" || fail "  nothing was written" "$(ls -la /srv/apps/ctg/releases /var/lib/layer-agent/catalog 2>&1)"
write_catalog "$good" "https://example.com/hello-0.1.0.tar.gz"
r="$(call catalog.fetch '{"slug":"ctg","app":"hello","version":"0.1.0"}')"
expect "a tarball on another host" "$r" '(.ok | not) and (.error.message | test("own address"))'
[[ "$(releases)" == "$before" && "$(leftovers)" == 0 ]] && pass "  nothing was written" || fail "  nothing was written" "$(ls -la /srv/apps/ctg/releases /var/lib/layer-agent/catalog 2>&1)"

echo
if ((failures == 0)); then echo "catalog e2e: all passed"; else
  echo "catalog e2e: $failures failed"
  exit 1
fi

#!/usr/bin/env bash
# Test helper: serves a release feed on 127.0.0.1:4996 with this release
# repacked under another version, and points the box at it. "catalog" then
# adds the integrations catalog beside it (catalog.json), listing one app
# built by scripts/build-catalog.ts.
#   sudo bash installer/test/release-feed.sh start <tarball> <install.sh> <version> [bad]
#   sudo bash installer/test/release-feed.sh catalog <app tarball>
#   sudo bash installer/test/release-feed.sh stop
# "bad" lists the release with a wrong checksum.
set -euo pipefail

dir=/srv/layer-test-releases
unit=layer-test-feed
config=/etc/layer/config.json
base=http://127.0.0.1:4996
sum() { sha256sum "$1" | cut -d' ' -f1; }

if [[ "${1:-}" == stop ]]; then
  systemctl stop "$unit" 2>/dev/null || true
  rm -rf "${dir:?}"
  exit 0
fi
if [[ "${1:-}" == catalog ]]; then
  app="${2:?usage: release-feed.sh catalog <app tarball>}"
  [[ -f "$dir/releases.json" ]] || { echo "start the feed first" >&2; exit 2; }
  manifest="$(tar -xzOf "$app" --wildcards '*/layer.json')"
  id="$(jq -r .id <<<"$manifest")" version="$(jq -r .version <<<"$manifest")"
  mkdir -p "$dir/catalog/$id/$version"
  cp "$app" "$dir/catalog/$id/$version/$id-$version.tar.gz"
  jq -n --argjson m "$manifest" --arg u "$base/catalog/$id/$version/$id-$version.tar.gz" --arg s "$(sum "$app")" \
    '{apps: [{id: $m.id, versions: [{version: $m.version, date: "2026-11-01", notes: "Test.", tarball: {url: $u, sha256: $s}, manifest: $m}]}]}' >"$dir/catalog.json"
  echo "catalog at $base/catalog.json lists $id $version"
  exit 0
fi
[[ "${1:-}" == start && $# -ge 4 ]] || { echo "usage: release-feed.sh start <tarball> <install.sh> <version> [bad] | catalog <app tarball> | stop" >&2; exit 2; }
tarball="$2" installer="$3" version="$4" bad="${5:-}"

rm -rf "${dir:?}" && mkdir -p "$dir"
tmp="$(mktemp -d)"
tar -xzf "$tarball" -C "$tmp"
top=("$tmp"/layer-*)
mv "${top[0]}" "$tmp/layer-$version"
echo "$version" >"$tmp/layer-$version/VERSION"
tar -czf "$dir/layer-$version.tar.gz" -C "$tmp" "layer-$version"
rm -rf "${tmp:?}"
cp "$installer" "$dir/install.sh"
tsum="$(sum "$dir/layer-$version.tar.gz")"
[[ -n "$bad" ]] && tsum="$(printf '0%.0s' {1..64})"
jq -n --arg v "$version" --arg t "$base/layer-$version.tar.gz" --arg ts "$tsum" --arg i "$base/install.sh" --arg is "$(sum "$dir/install.sh")" \
  '{releases: [{version: $v, date: "2026-11-01", notes: "Test release.", tarball: {url: $t, sha256: $ts}, installer: {url: $i, sha256: $is}}]}' >"$dir/releases.json"

systemctl stop "$unit" 2>/dev/null || true
systemctl reset-failed "$unit" 2>/dev/null || true
systemd-run --quiet --unit="$unit" --property=DynamicUser=yes /usr/bin/python3 -m http.server 4996 --bind 127.0.0.1 --directory "$dir"
for _ in $(seq 1 20); do curl -fsS "$base/releases.json" >/dev/null 2>&1 && break; sleep 0.5; done

jq --arg u "$base/releases.json" '.updatesUrl = $u' "$config" >"$config.new"
install -m 640 -o root -g layer "$config.new" "$config"
rm -f "$config.new"
echo "feed at $base/releases.json offers $version"

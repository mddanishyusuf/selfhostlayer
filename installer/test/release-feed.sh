#!/usr/bin/env bash
# Test helper: serves a release feed on 127.0.0.1:4996 with this release
# repacked under another version, and points the box at it. "catalog" then
# puts the integrations catalog beside it (catalog.json), listing the apps
# built by scripts/build-catalog.ts; <tarball>=<version> lists one as another
# version too (for update tests). Each run replaces the catalog.
#   sudo bash installer/test/release-feed.sh start <tarball> <install.sh> <version> [bad]
#   sudo bash installer/test/release-feed.sh catalog <app tarball>[=<version>]...
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
  shift
  (($#)) || { echo "usage: release-feed.sh catalog <app tarball>[=<version>]..." >&2; exit 2; }
  [[ -f "$dir/releases.json" ]] || { echo "start the feed first" >&2; exit 2; }
  rm -rf "${dir:?}/catalog"
  entries=()
  for spec in "$@"; do
    app="${spec%%=*}" as=""
    [[ "$spec" == *=* ]] && as="${spec#*=}"
    manifest="$(tar -xzOf "$app" --wildcards '*/layer.json')"
    id="$(jq -r .id <<<"$manifest")" version="$(jq -r .version <<<"$manifest")"
    file="$app" tmp=""
    if [[ -n "$as" ]]; then
      # The same app as another version, for update tests.
      tmp="$(mktemp -d)"
      tar -xzf "$app" -C "$tmp"
      top=("$tmp"/*)
      manifest="$(jq --arg v "$as" '.version = $v' <<<"$manifest")"
      printf '%s\n' "$manifest" >"${top[0]}/layer.json"
      mv "${top[0]}" "$tmp/$id-$as"
      version="$as" file="$tmp/$id-$as.tar.gz"
      tar -czf "$file" -C "$tmp" "$id-$as"
    fi
    mkdir -p "$dir/catalog/$id/$version"
    cp "$file" "$dir/catalog/$id/$version/$id-$version.tar.gz"
    entries+=("$(jq -nc --argjson m "$manifest" --arg u "$base/catalog/$id/$version/$id-$version.tar.gz" --arg s "$(sum "$file")" \
      '{id: $m.id, version: {version: $m.version, date: "2026-11-01", notes: "Test.", tarball: {url: $u, sha256: $s}, manifest: $m}}')")
    [[ -z "$tmp" ]] || rm -rf "${tmp:?}"
  done
  # One entry per app, its versions newest first.
  printf '%s\n' "${entries[@]}" | jq -s 'group_by(.id) | map({id: .[0].id, versions: (map(.version) | sort_by(.version | split(".") | map(tonumber)) | reverse)}) | {apps: .}' >"$dir/catalog.json"
  echo "catalog at $base/catalog.json lists $(jq -r '[.apps[] | "\(.id) \([.versions[].version] | join(" "))"] | join(", ")' "$dir/catalog.json")"
  exit 0
fi
[[ "${1:-}" == start && $# -ge 4 ]] || { echo "usage: release-feed.sh start <tarball> <install.sh> <version> [bad] | catalog <app tarball>[=<version>]... | stop" >&2; exit 2; }
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

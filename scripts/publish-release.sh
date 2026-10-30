#!/usr/bin/env bash
# Publishes a release to the update feed, https://get.selfhostlayer.com/releases.json.
# Builds the release and its installer from the commit you're on, uploads both
# to the server that runs the website (into the shl project's data folder,
# which the website serves under /releases/), and puts the release at the top
# of the feed. Every panel offers it at its next check.
#   LAYER_RELEASE_HOST=root@<server> scripts/publish-release.sh <version> [--notes "…"]
# The notes default to the subjects of the commits since the last release.
# SC2029: the ssh commands name paths on the server, filled in here on purpose.
# shellcheck disable=SC2029
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
host="${LAYER_RELEASE_HOST:?set LAYER_RELEASE_HOST to the server that runs the website, like root@203.0.113.7}"
app="${LAYER_RELEASE_APP:-shl}"
feed_url="${LAYER_RELEASE_FEED:-https://get.selfhostlayer.com/releases.json}"
files_url="${feed_url%/releases.json}/releases"
dir="/srv/apps/$app/data/releases"

die() { echo "publish-release: $*" >&2; exit 1; }
sum() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

version="${1:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "usage: publish-release.sh <version like 0.2.0> [--notes \"…\"]"
shift
notes=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --notes) notes="${2:?--notes needs text}"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

# A release is a commit everyone can find: nothing uncommitted, and already on GitHub.
[[ -z "$(git -C "$root" status --porcelain)" ]] || die "commit or stash your changes first"
git -C "$root" merge-base --is-ancestor HEAD origin/main || die "push $(git -C "$root" rev-parse --short HEAD) to origin/main first"
commit="$(git -C "$root" rev-parse --short HEAD)"

echo "Reading the feed on $host"
feed="$(ssh "$host" "cat '$dir/releases.json' 2>/dev/null || echo '{\"releases\":[]}'")"
node "$root/scripts/release-feed.ts" check "$version" <<<"$feed"
if [[ -z "$notes" ]]; then
  last="$(node "$root/scripts/release-feed.ts" last-commit <<<"$feed")"
  if [[ -n "$last" ]] && git -C "$root" cat-file -e "$last^{commit}" 2>/dev/null; then
    notes="$(git -C "$root" log --no-merges --format=%s "$last..HEAD" | head -12)"
  fi
fi

echo "Building $version from $commit"
bash "$root/scripts/build-release.sh" "$version"
bash "$root/scripts/build-installer.sh" "$version"
tarball="$root/dist/layer-$version.tar.gz"
installer="$root/dist/install.sh"
tsum="$(sum "$tarball")"
isum="$(sum "$installer")"
new_feed="$root/dist/releases.json"
node "$root/scripts/release-feed.ts" add "$version" "$commit" "$notes" \
  "$files_url/$version/layer-$version.tar.gz" "$tsum" "$files_url/$version/install.sh" "$isum" <<<"$feed" >"$new_feed"
keep=()
while IFS= read -r v; do keep+=("$v"); done < <(node "$root/scripts/release-feed.ts" versions <"$new_feed")

echo "Uploading to $host:$dir"
ssh "$host" "id -u 'app-$app' >/dev/null && install -d -o 'app-$app' -g 'app-$app' -m 755 '$dir' && rm -rf '$dir/.upload' && install -d -m 700 '$dir/.upload'"
scp -q "$tarball" "$installer" "$new_feed" "$host:$dir/.upload/"
# Checked again on the server, then moved into place: the files first, the feed that names them last.
ssh "$host" bash -s -- "$dir" "$app" "$version" "$tsum" "$isum" "${keep[@]}" <<'EOF'
set -euo pipefail
dir="$1" app="$2" version="$3" tsum="$4" isum="$5"
shift 5
up="$dir/.upload"
sum() { sha256sum "$1" | cut -d' ' -f1; }
[[ "$(sum "$up/layer-$version.tar.gz")" == "$tsum" && "$(sum "$up/install.sh")" == "$isum" ]] || { echo "the upload doesn't match its checksums" >&2; exit 1; }
rm -rf "${dir:?}/${version:?}"
install -d -o "app-$app" -g "app-$app" -m 755 "$dir/$version"
install -o "app-$app" -g "app-$app" -m 644 "$up/layer-$version.tar.gz" "$up/install.sh" "$dir/$version/"
install -o "app-$app" -g "app-$app" -m 644 "$up/releases.json" "$dir/releases.json.new"
mv -f "$dir/releases.json.new" "$dir/releases.json"
# Releases that fell off the feed go.
for d in "$dir"/*/; do
  v="$(basename "$d")"
  listed=0
  for k in "$@"; do [[ "$v" == "$k" ]] && listed=1; done
  ((listed)) || rm -rf "${dir:?}/${v:?}"
done
rm -rf "${up:?}"
EOF

if curl -fsS --max-time 20 "$feed_url" 2>/dev/null | grep -q "\"version\": \"$version\""; then
  echo "✓ $feed_url offers $version (sha256 $tsum)"
else
  echo "! Published on $host, but $feed_url doesn't offer it yet: does get.selfhostlayer.com point at that server?" >&2
fi

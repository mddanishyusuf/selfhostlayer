#!/usr/bin/env bash
# Publishes a catalog app (an integration) to https://get.selfhostlayer.com/catalog.json.
# Builds the app from the commit you're on (scripts/build-catalog.ts), uploads
# the tarball to the server that runs the website (into the shl project's data
# folder, which the website serves under /catalog/), and puts the version on
# top of that app's list in the catalog. Every panel's Integrations page offers
# it the next time it reads the catalog.
#   LAYER_RELEASE_HOST=root@<server> scripts/publish-catalog.sh <app> [--notes "…"] [--min-panel <version>]
# --min-panel: the oldest Self Host Layer that can install this version.
# SC2029: the ssh commands name paths on the server, filled in here on purpose.
# shellcheck disable=SC2029
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
host="${LAYER_RELEASE_HOST:?set LAYER_RELEASE_HOST to the server that runs the website, like root@203.0.113.7}"
site="${LAYER_RELEASE_APP:-shl}"
catalog_url="${LAYER_CATALOG_URL:-https://get.selfhostlayer.com/catalog.json}"
files_url="${catalog_url%/catalog.json}/catalog"
dir="/srv/apps/$site/data/catalog"

die() { echo "publish-catalog: $*" >&2; exit 1; }
sum() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

app="${1:-}"
[[ "$app" =~ ^[a-z][a-z0-9-]{0,30}$ && -f "$root/catalog/$app/layer.yaml" ]] || die "usage: publish-catalog.sh <app, a folder in catalog/> [--notes \"…\"] [--min-panel <version>]"
shift
notes="" min_panel=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --notes) notes="${2:?--notes needs text}"; shift 2 ;;
    --min-panel) min_panel="${2:?--min-panel needs a version}"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ -z "$min_panel" || "$min_panel" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "--min-panel must be a version like 0.2.0"

# Like a release, a commit everyone can find: nothing uncommitted, and already on GitHub.
[[ -z "$(git -C "$root" status --porcelain)" ]] || die "commit or stash your changes first"
git -C "$root" merge-base --is-ancestor HEAD origin/main || die "push $(git -C "$root" rev-parse --short HEAD) to origin/main first"

echo "Building $app from $(git -C "$root" rev-parse --short HEAD)"
mkdir -p "$root/dist/catalog"
build="$root/dist/catalog/$app.build.json"
node "$root/scripts/build-catalog.ts" "$app" | tail -1 >"$build"
file="$(jq -r .file "$build")"
sha="$(jq -r .sha256 "$build")"
version="$(jq -r .manifest.version "$build")"
[[ "$(sum "$file")" == "$sha" ]] || die "the build's checksum doesn't match its file"

echo "Reading the catalog on $host"
current="$(ssh "$host" "cat '$dir/catalog.json' 2>/dev/null || echo '{\"apps\":[]}'")"
new_catalog="$root/dist/catalog/catalog.json"
node "$root/scripts/catalog-feed.ts" add "$build" "$files_url/$app/$version/$app-$version.tar.gz" "$catalog_url" "$notes" "$min_panel" <<<"$current" >"$new_catalog"
keep=()
while IFS= read -r v; do keep+=("$v"); done < <(node "$root/scripts/catalog-feed.ts" versions "$app" <"$new_catalog")

echo "Uploading $app $version to $host:$dir"
ssh "$host" "id -u 'app-$site' >/dev/null && install -d -o 'app-$site' -g 'app-$site' -m 755 '$dir' && rm -rf '$dir/.upload' && install -d -m 700 '$dir/.upload'"
scp -q "$file" "$new_catalog" "$host:$dir/.upload/"
# Checked again on the server, then moved into place: the tarball first, the catalog that names it last.
ssh "$host" bash -s -- "$dir" "$site" "$app" "$version" "$sha" "${keep[@]}" <<'EOF'
set -euo pipefail
dir="$1" site="$2" app="$3" version="$4" sha="$5"
shift 5
up="$dir/.upload"
[[ "$(sha256sum "$up/$app-$version.tar.gz" | cut -d' ' -f1)" == "$sha" ]] || { echo "the upload doesn't match its checksum" >&2; exit 1; }
install -d -o "app-$site" -g "app-$site" -m 755 "$dir/$app" "$dir/$app/$version"
install -o "app-$site" -g "app-$site" -m 644 "$up/$app-$version.tar.gz" "$dir/$app/$version/"
install -o "app-$site" -g "app-$site" -m 644 "$up/catalog.json" "$dir/catalog.json.new"
mv -f "$dir/catalog.json.new" "$dir/catalog.json"
# This app's versions that fell off the catalog go.
for d in "$dir/$app"/*/; do
  v="$(basename "$d")"
  listed=0
  for k in "$@"; do [[ "$v" == "$k" ]] && listed=1; done
  ((listed)) || rm -rf "${dir:?}/${app:?}/${v:?}"
done
rm -rf "${up:?}"
EOF

if curl -fsS --max-time 20 "$catalog_url" 2>/dev/null | node "$root/scripts/catalog-feed.ts" has "$app" "$version" 2>/dev/null; then
  echo "✓ $catalog_url lists $app $version (sha256 $sha)"
else
  echo "! Published on $host, but $catalog_url doesn't list it yet: does get.selfhostlayer.com point at that server, with the website's catalog routes?" >&2
fi

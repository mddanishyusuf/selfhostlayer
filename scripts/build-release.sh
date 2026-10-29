#!/usr/bin/env bash
# Builds the release tarball the installer unpacks into /opt/layer/releases/<version>:
#   layer-<version>/
#     VERSION
#     agent/layer-agent.mjs  agent/layer.mjs     (bundled, Node built-ins only)
#     web/                                       (Next.js standalone, no install step)
#       panel/server.mjs                         (unix-socket entry point)
#     system/layer-agent.service  system/layer-panel.service
#
#   scripts/build-release.sh [version]   → dist/layer-<version>.tar.gz
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${1:-dev-$(git -C "$root" rev-parse --short HEAD)}"
[[ "$version" =~ ^[0-9A-Za-z._-]+$ ]] || { echo "bad version: $version" >&2; exit 1; }
stage="$root/dist/release/layer-$version"
out="$root/dist/layer-$version.tar.gz"

bash "$root/scripts/build-agent.sh" "$version"
(cd "$root/panel" && NEXT_TELEMETRY_DISABLED=1 "$root/node_modules/.bin/next" build >/dev/null)

rm -rf "$stage"
mkdir -p "$stage/agent" "$stage/system"
cp "$root/dist/agent/layer-agent.mjs" "$root/dist/agent/layer.mjs" "$stage/agent/"
cp -R "$root/panel/.next/standalone" "$stage/web"
# Standalone output leaves static assets out; the server expects them here.
cp -R "$root/panel/.next/static" "$stage/web/panel/.next/static"
if [[ -d "$root/panel/public" ]]; then cp -R "$root/panel/public" "$stage/web/panel/public"; fi
cp "$root/panel/server.mjs" "$stage/web/panel/server.mjs"
cp "$root/system/layer-agent.service" "$root/system/layer-panel.service" "$stage/system/"
echo "$version" >"$stage/VERSION"

# Next's file tracing copies test files and dev scripts into standalone output
# despite outputFileTracingExcludes; they don't belong in a release.
find "$stage/web" -path "*/node_modules" -prune -o \( -name "*.test.ts" -o -path "*/panel/scripts" \) -print0 | xargs -0 rm -rf

# Never ship local dev state (DB, keys, tokens).
if find "$stage" -name ".dev" -o -name "*.db" -o -name "secret.key" -o -name "setup-token" | grep -q .; then
  echo "refusing to package dev state:" >&2
  find "$stage" -name ".dev" -o -name "*.db" -o -name "secret.key" -o -name "setup-token" >&2
  exit 1
fi

tar_flags=(-czf)
if tar --version 2>/dev/null | grep -q bsdtar; then tar_flags=(--no-xattrs --no-mac-metadata -czf); fi
COPYFILE_DISABLE=1 tar -C "$root/dist/release" "${tar_flags[@]}" "$out" "layer-$version"
echo "built $out ($(du -h "$out" | cut -f1), sha256 $(shasum -a 256 "$out" | cut -d' ' -f1))"

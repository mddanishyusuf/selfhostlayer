#!/usr/bin/env bash
# Bundles the agent into one file with no node_modules at runtime:
# dist/agent/layer-agent.mjs, run by the pinned Node in /opt/layer/runtime.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${1:-dev}"
out="$root/dist/agent/layer-agent.mjs"

"$root/node_modules/.bin/esbuild" "$root/agent/src/main.ts" \
  --bundle --platform=node --target=node24 --format=esm \
  --define:LAYER_AGENT_VERSION="\"$version\"" \
  --legal-comments=none --log-level=warning \
  --outfile="$out"

# Only Node built-ins may stay as imports: everything else must be bundled.
if grep -Eo 'from ?"[^"]+"' "$out" | grep -v '"node:' | grep -q .; then
  echo "bundle imports non-builtin modules:" >&2
  grep -Eo 'from ?"[^"]+"' "$out" | grep -v '"node:' | sort -u >&2
  exit 1
fi
echo "built $out ($(wc -c <"$out" | tr -d ' ') bytes, sha256 $(shasum -a 256 "$out" | cut -d' ' -f1))"

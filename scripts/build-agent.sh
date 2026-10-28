#!/usr/bin/env bash
# Bundles the agent and the `layer` CLI, each into one file with no
# node_modules at runtime, run by the pinned Node in /opt/layer/runtime:
#   dist/agent/layer-agent.mjs   dist/agent/layer.mjs
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${1:-dev}"

bundle() {
  local entry="$1" out="$2"
  shift 2
  "$root/node_modules/.bin/esbuild" "$entry" \
    --bundle --platform=node --target=node24 --format=esm \
    --define:LAYER_AGENT_VERSION="\"$version\"" \
    --legal-comments=none --log-level=warning \
    --outfile="$out" "$@"
  # Only Node built-ins may stay as imports: everything else must be bundled.
  if grep -Eo 'from ?"[^"]+"' "$out" | grep -v '"node:' | grep -q .; then
    echo "bundle imports non-builtin modules:" >&2
    grep -Eo 'from ?"[^"]+"' "$out" | grep -v '"node:' | sort -u >&2
    exit 1
  fi
  echo "built $out ($(wc -c <"$out" | tr -d ' ') bytes, sha256 $(shasum -a 256 "$out" | cut -d' ' -f1))"
}

bundle "$root/agent/src/main.ts" "$root/dist/agent/layer-agent.mjs"
bundle "$root/packages/cli/src/main.ts" "$root/dist/agent/layer.mjs" --banner:js="#!/opt/layer/runtime/bin/node"
chmod 755 "$root/dist/agent/layer.mjs"

#!/usr/bin/env bash
# Inlines installer/lib/*.sh into installer/install.sh, producing dist/install.sh:
# the single file served at get.selfhostlayer.com.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/installer/install.sh"
out="$root/dist/install.sh"
version="${1:-dev}"
marker="# @layer-inline-libs"
# The literal source line to rewrite with the release version.
# shellcheck disable=SC2016
version_line='LAYER_VERSION="${LAYER_VERSION:-dev}"'

grep -qx "$marker" "$src" || { echo "marker '$marker' missing from $src" >&2; exit 1; }
mkdir -p "$root/dist"

{
  while IFS= read -r line; do
    if [[ "$line" == "$marker" ]]; then
      echo "LAYER_BUNDLED=1"
      for lib in "$root"/installer/lib/*.sh; do
        echo
        echo "# --- ${lib#"$root"/} ---"
        grep -v '^# shellcheck shell=bash$' "$lib"
      done
    elif [[ "$line" == "$version_line" ]]; then
      echo "LAYER_VERSION=\"\${LAYER_VERSION:-$version}\""
    else
      printf '%s\n' "$line"
    fi
  done <"$src"
} >"$out"

chmod +x "$out"
bash -n "$out"
# Partial-download safety: the last non-empty line must be the only call to main.
[[ "$(grep -v '^[[:space:]]*$' "$out" | tail -1)" == 'main "$@"' ]] || { echo "last line of $out must be: main \"\$@\"" >&2; exit 1; }
echo "built $out ($(wc -l <"$out" | tr -d ' ') lines, sha256 $(shasum -a 256 "$out" | cut -d' ' -f1))"

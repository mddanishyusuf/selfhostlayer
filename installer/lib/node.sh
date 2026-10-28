# shellcheck shell=bash
# Step 4: the default Node runtime, as an official tarball with a verified
# checksum in read-only /opt/layer/node/<version>/. Apps pin their own versions
# later through the agent's node.install action.

LAYER_NODE_DEFAULT="${LAYER_NODE_DEFAULT:-24.13.1}"
NODE_ROOT=/opt/layer/node

install_node() {
  step "Installing Node $LAYER_NODE_DEFAULT"
  local version="$LAYER_NODE_DEFAULT"
  local dest="$NODE_ROOT/$version"

  if [[ -x "$dest/bin/node" && "$("$dest/bin/node" -v)" == "v$version" ]]; then
    ok "Node $version already in $dest"
    return
  fi

  local tarball="node-v$version-linux-$LAYER_NODE_ARCH.tar.xz"
  local base="https://nodejs.org/dist/v$version"
  local tmp
  tmp="$(mktemp -d)"
  run curl -fsSL -o "$tmp/$tarball" "$base/$tarball"
  run curl -fsSL -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  if ! (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c --status -); then
    rm -rf "$tmp"
    die "checksum mismatch for $tarball"
  fi
  ok "Checksum verified"

  # Unpack next to the target, then rename, so a half-extracted runtime never
  # appears at the real path.
  install -d -m 755 "$NODE_ROOT"
  rm -rf "$dest.partial"
  install -d -m 755 "$dest.partial"
  run tar -xJf "$tmp/$tarball" -C "$dest.partial" --strip-components=1 --no-same-owner
  rm -rf "$tmp" "$dest"
  mv "$dest.partial" "$dest"
  chown -R root:root "$dest"
  chmod -R go-w "$dest"
  ok "Node $("$dest/bin/node" -v) in $dest"
}

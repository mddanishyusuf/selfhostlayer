# shellcheck shell=bash
# Step 6: unpack the release (agent, CLI, panel, units) into
# /opt/layer/releases/<version> and point /opt/layer/current at it.

RELEASES_DIR=/opt/layer/releases
KEEP_RELEASES=3

install_release() {
  step "Installing Self Host Layer"
  if [[ -z "$LAYER_TARBALL" ]]; then
    die "public release downloads arrive at launch; for now pass --from-tarball <layer-VERSION.tar.gz>"
  fi

  local tmp version
  tmp="$(mktemp -d)"
  run tar -xzf "$LAYER_TARBALL" -C "$tmp" --no-same-owner
  local top=("$tmp"/layer-*)
  [[ ${#top[@]} -eq 1 && -f "${top[0]}/VERSION" ]] || die "not a Self Host Layer release: $LAYER_TARBALL"
  version="$(tr -d '[:space:]' <"${top[0]}/VERSION")"
  [[ "$version" =~ ^[0-9A-Za-z._-]+$ ]] || die "bad version in release: $version"
  local f
  for f in agent/layer-agent.mjs agent/layer.mjs web/panel/server.mjs system/layer-agent.service system/layer-panel.service; do
    [[ -f "${top[0]}/$f" ]] || die "release is missing $f"
  done

  install -d -m 755 "$RELEASES_DIR"
  # ${var:?} guards: an empty value aborts instead of widening the rm.
  rm -rf "${RELEASES_DIR:?}/${version:?}"
  mv "${top[0]}" "$RELEASES_DIR/$version"
  rm -rf "${tmp:?}"
  chown -R root:root "$RELEASES_DIR/$version"
  chmod -R go-w "$RELEASES_DIR/$version"
  chmod 755 "$RELEASES_DIR/$version/agent/layer.mjs"

  ln -sfn "releases/$version" /opt/layer/current
  ln -sfn "node/$LAYER_NODE_DEFAULT" /opt/layer/runtime
  ln -sfn /opt/layer/current/agent/layer.mjs /usr/local/bin/layer
  # Read by finish.sh.
  # shellcheck disable=SC2034
  LAYER_INSTALLED_VERSION="$version"

  # Keep the newest few releases for rollback; never the current one.
  local old
  while IFS= read -r old; do
    [[ -n "$old" && "$old" != "$version" ]] || continue
    rm -rf "${RELEASES_DIR:?}/${old:?}"
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -rn | cut -d' ' -f2- | tail -n +$((KEEP_RELEASES + 1)))
  ok "Release $version in /opt/layer/current"
}

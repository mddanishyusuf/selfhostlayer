# shellcheck shell=bash
# An agent-only server: the managing panel reaches the agent over SSH as
# layer-link, whose key is locked to one command (PLAN-SERVERS.md): a pipe to
# the agent's socket. No shell, no forwarding, no other command, so a panel
# can do here exactly what it can do on its own server: the agent's
# allowlisted actions. No root key is ever handed to a panel.

LINK_USER=layer-link
LINK_HOME=/var/lib/layer-link

setup_link() {
  step "Letting the panel in"
  if ! id "$LINK_USER" &>/dev/null; then
    # A real shell: sshd runs the forced command through it (nologin would refuse).
    run useradd --system --user-group --shell /bin/sh --home-dir "$LINK_HOME" --create-home "$LINK_USER"
  fi
  # The agent's socket is root:layer 660.
  # Exact: grep -w would find "layer" in layer-link's own group, "layer-link".
  id -nG "$LINK_USER" | tr ' ' '\n' | grep -qx "$LAYER_USER" || run usermod -aG "$LAYER_USER" "$LINK_USER"
  passwd -l "$LINK_USER" >/dev/null 2>&1 || true
  install -d -o "$LINK_USER" -g "$LINK_USER" -m 700 "$LINK_HOME/.ssh"
  if [[ -n "$LAYER_PANEL_KEY" ]]; then
    install -m 600 -o "$LINK_USER" -g "$LINK_USER" /dev/null "$LINK_HOME/.ssh/authorized_keys.new"
    printf 'restrict,command="/usr/bin/socat STDIO UNIX-CONNECT:/run/layer/agent.sock" %s\n' "$LAYER_PANEL_KEY" >"$LINK_HOME/.ssh/authorized_keys.new"
    mv "$LINK_HOME/.ssh/authorized_keys.new" "$LINK_HOME/.ssh/authorized_keys"
    ok "The panel's key may reach the agent, and nothing else"
  elif [[ -s "$LINK_HOME/.ssh/authorized_keys" ]]; then
    ok "The panel's key is already in place"
  else
    die "--agent-only needs --panel-key (copy the command from the panel's Settings → Servers)"
  fi
}

finish_agent() {
  local bar="$C_GREEN│$C_RESET"
  printf '\n%s┌──────────────────────────────────────────────────────────────┐%s\n' "$C_GREEN" "$C_RESET"
  printf '%s  %sThis server is ready for your panel%s (%s)\n' "$bar" "$C_BOLD" "$C_RESET" "$LAYER_INSTALLED_VERSION"
  printf '%s\n' "$bar"
  printf '%s  Back in the panel: Settings → Servers → %sCheck connection%s\n' "$bar" "$C_BOLD" "$C_RESET"
  printf '%s  Its address: %s%s%s\n' "$bar" "$C_BOLD" "$LAYER_PUBLIC_IP" "$C_RESET"
  printf '%s└──────────────────────────────────────────────────────────────┘%s\n\n' "$C_GREEN" "$C_RESET"
  log "finished: agent-only for a panel elsewhere"
  info "Full log: $LAYER_LOG"
}

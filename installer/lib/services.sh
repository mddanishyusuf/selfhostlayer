# shellcheck shell=bash
# Step 11: install and (re)start layer-agent and layer-panel from the release,
# then wait until both answer.

start_services() {
  step "Starting services"
  install -m 644 /opt/layer/current/system/layer-agent.service /etc/systemd/system/layer-agent.service
  install -m 644 /opt/layer/current/system/layer-panel.service /etc/systemd/system/layer-panel.service
  run systemctl daemon-reload
  run systemctl enable layer-agent layer-panel
  # Restart, so a re-run picks up a new release.
  run systemctl restart layer-agent
  wait_for "agent socket" test -S /run/layer/agent.sock
  run systemctl restart layer-panel
  # As the caddy user: the same path real traffic takes (root could always connect).
  wait_for "panel" runuser -u caddy -- curl -fsS --unix-socket /run/layer-panel/panel.sock http://panel/api/health
  ok "layer-agent and layer-panel running"
}

wait_for() {
  local what="$1"
  shift
  local _
  for _ in $(seq 1 120); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  journalctl -u layer-agent -u layer-panel -n 30 --no-pager >>"$LAYER_LOG" 2>&1 || true
  die "$what didn't come up within 60s (see $LAYER_LOG and journalctl -u layer-panel)"
}

# An agent-only server: the agent, no panel (another server's panel manages it).
start_agent() {
  step "Starting the agent"
  install -m 644 /opt/layer/current/system/layer-agent.service /etc/systemd/system/layer-agent.service
  run systemctl daemon-reload
  run systemctl enable layer-agent
  run systemctl restart layer-agent
  wait_for "agent socket" test -S /run/layer/agent.sock
  # A panel left from an earlier full install would have no one to sign in.
  if systemctl is-enabled --quiet layer-panel 2>/dev/null; then run systemctl disable --now layer-panel; fi
  ok "layer-agent running"
}

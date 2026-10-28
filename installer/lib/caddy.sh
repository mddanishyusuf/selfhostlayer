# shellcheck shell=bash
# Step 8 (base): Caddy imports one generated file per app from
# /etc/caddy/sites/, and its admin API listens on a root-and-caddy-only unix
# socket instead of localhost:2019, which any app on the box could reach.

CADDY_SITES=/etc/caddy/sites

setup_caddy() {
  step "Configuring Caddy"
  install -d -m 755 "$CADDY_SITES"

  install -d -m 755 /etc/systemd/system/caddy.service.d
  cat >/etc/systemd/system/caddy.service.d/10-layer.conf <<'EOF'
# Managed by Self Host Layer: a private runtime dir for the admin socket.
[Service]
RuntimeDirectory=caddy
RuntimeDirectoryMode=0700
EOF

  cat >/etc/caddy/Caddyfile.new <<'EOF'
# Managed by Self Host Layer. Per-app sites live in /etc/caddy/sites/.
{
	admin unix//run/caddy/admin.sock
}

import /etc/caddy/sites/*.caddy
EOF
  run caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile
  mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile

  run systemctl daemon-reload
  # Restart (not reload): the admin endpoint itself moves.
  run systemctl restart caddy
  ok "Caddy: sites in $CADDY_SITES, admin API on /run/caddy/admin.sock"
}

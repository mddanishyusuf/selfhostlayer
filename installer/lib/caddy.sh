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

# Step 8 (panel): the panel's own site. Caddy reaches the panel through a unix
# socket shared via the layer-web group (only caddy and layer are members;
# setup_users adds them).
setup_panel_site() {
  step "Publishing the panel"
  LAYER_PANEL_HOST="${LAYER_DOMAIN:-${LAYER_PUBLIC_IP//./-}.sslip.io}"
  local tls=""
  [[ "$LAYER_INTERNAL_TLS" == 1 ]] && tls=$'\n\ttls internal'

  # _panel can't clash with an app: app slugs start with a letter.
  cat >"$CADDY_SITES/_panel.caddy" <<SITE
# Self Host Layer panel. Managed by the installer.
$LAYER_PANEL_HOST {$tls
	encode zstd gzip
	reverse_proxy unix//run/layer-panel/panel.sock
	log {
		output file /var/log/caddy/_panel.log {
			roll_size 10MiB
			roll_keep 5
		}
		format json
	}
}
SITE
  # setup_users put caddy in layer-web before setup_caddy restarted it.
  run systemctl reload caddy
  ok "Panel at https://$LAYER_PANEL_HOST"
}

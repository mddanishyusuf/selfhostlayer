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
# setup_users adds them). The agent writes the site from config.json: the same
# code Settings → Panel address uses, so a re-run keeps an address set there.
setup_panel_site() {
  step "Publishing the panel"
  local current=""
  [[ -f /etc/layer/config.json ]] && current="$(jq -r '.panelHost // empty' /etc/layer/config.json)"
  LAYER_PANEL_HOST="${LAYER_DOMAIN:-${current:-${LAYER_PUBLIC_IP//./-}.sslip.io}}"
  write_config
  # setup_users put caddy in layer-web before setup_caddy restarted it.
  run layer call panel.site
  ok "Panel at https://$LAYER_PANEL_HOST"
}

# /etc/layer/config.json: what the panel needs to know about this box. Every
# app gets a free URL <app>.<appsDomain>, which works without any DNS setup.
# Keys this run doesn't set (old addresses that redirect, an apps domain set
# in the panel) are kept.
write_config() {
  local old='{}'
  [[ -f /etc/layer/config.json ]] && old="$(cat /etc/layer/config.json)"
  local apps_domain="${LAYER_APPS_DOMAIN:-$(jq -r '.appsDomain // empty' <<<"$old")}"
  apps_domain="${apps_domain:-${LAYER_PUBLIC_IP//./-}.sslip.io}"
  local internal=false
  [[ "$LAYER_INTERNAL_TLS" == 1 ]] && internal=true
  install -m 640 -o root -g "$LAYER_USER" /dev/null /etc/layer/config.json.new
  jq -n --argjson old "$old" --arg panelHost "$LAYER_PANEL_HOST" --arg appsDomain "$apps_domain" --arg publicIp "$LAYER_PUBLIC_IP" \
    --arg version "$LAYER_INSTALLED_VERSION" --arg node "$LAYER_NODE_DEFAULT" --argjson internalTls "$internal" \
    '$old + {panelHost: $panelHost, appsDomain: $appsDomain, publicIp: $publicIp, version: $version, defaultNode: $node, internalTls: $internalTls}' \
    >/etc/layer/config.json.new
  mv /etc/layer/config.json.new /etc/layer/config.json
  ok "Apps get free URLs at https://<app>.$apps_domain"
}

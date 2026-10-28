# shellcheck shell=bash
# Step 5: the panel user, the app group, and the base directory layout.
# Modes follow the server layout table in PLAN-WEEK1.md.

LAYER_USER=layer
LAYER_APPS_GROUP=layer-apps
# Shared only by caddy and layer, so Caddy can reach the panel's socket.
LAYER_WEB_GROUP=layer-web

setup_users() {
  step "Creating users and directories"

  getent group "$LAYER_APPS_GROUP" >/dev/null || run groupadd --system "$LAYER_APPS_GROUP"
  getent group "$LAYER_WEB_GROUP" >/dev/null || run groupadd --system "$LAYER_WEB_GROUP"
  if ! id "$LAYER_USER" &>/dev/null; then
    run useradd --system --user-group --shell /usr/sbin/nologin \
      --home-dir /var/lib/layer --no-create-home "$LAYER_USER"
  fi
  id -nG "$LAYER_USER" | grep -qw "$LAYER_WEB_GROUP" || run usermod -aG "$LAYER_WEB_GROUP" "$LAYER_USER"
  # Before setup_caddy restarts Caddy, so the running Caddy has the group by
  # the time start_services health-checks the panel socket as the caddy user.
  id -nG caddy | grep -qw "$LAYER_WEB_GROUP" || run usermod -aG "$LAYER_WEB_GROUP" caddy
  ok "Users: $LAYER_USER (panel), groups $LAYER_APPS_GROUP (apps), $LAYER_WEB_GROUP (panel socket)"

  # path                owner             mode
  layer_dir /opt/layer      root:root         755
  layer_dir /opt/layer/tools root:root        755
  layer_dir /etc/layer      "root:$LAYER_USER" 750
  layer_dir /etc/layer/apps root:root         755
  layer_dir /var/lib/layer  "$LAYER_USER:$LAYER_USER" 700
  layer_dir /var/log/layer  root:root         700
  # 711: app users can reach their own folder but can't list the others.
  layer_dir /srv/apps       root:root         711
  # Published static sites: each site folder is root:caddy 750 (made by the agent).
  layer_dir /srv/static     root:root         711
  ok "Directories under /opt/layer, /etc/layer, /var/lib/layer, /var/log/layer, /srv/apps"
}

layer_dir() {
  local path="$1" owner="$2" mode="$3"
  install -d -o "${owner%%:*}" -g "${owner##*:}" -m "$mode" "$path"
  # install -d leaves existing dirs' owner and mode alone, so enforce them.
  chown "$owner" "$path"
  chmod "$mode" "$path"
}

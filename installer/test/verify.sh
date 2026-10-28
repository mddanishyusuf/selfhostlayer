#!/usr/bin/env bash
# Asserts the server state the installer promises. Run as root after install.sh:
#   sudo bash installer/test/verify.sh [--expect-ssh-hardened]
# Exits non-zero if any check fails. Used by CI and scripts/dev-vm.sh verify.
set -uo pipefail

node_version="${LAYER_NODE_DEFAULT:-24.13.1}"
expect_ssh_hardened=0
[[ "${1:-}" == --expect-ssh-hardened ]] && expect_ssh_hardened=1

failures=0
check() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf '  \e[32m✓\e[0m %s\n' "$name"
  else
    printf '  \e[31m✗\e[0m %s\n' "$name"
    failures=$((failures + 1))
  fi
}

mode_is() { [[ "$(stat -c '%a %U:%G' "$1")" == "$2" ]]; }
active() { systemctl is-active --quiet "$1"; }
sshd_says() { grep -qx "$1" <<<"$(sshd -T 2>/dev/null)"; }
ufw_allows() { grep -qE "^$1 +ALLOW" <<<"$(ufw status)"; }
swap_ok() {
  local mem_mb
  mem_mb="$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo)"
  ((mem_mb >= 4096)) || [[ -n "$(swapon --show --noheadings)" ]]
}
no_writable_node_files() { [[ -z "$(find /opt/layer/node -type f -perm /022)" ]]; }

echo "Node"
check "node $node_version runs" test "$("/opt/layer/node/$node_version/bin/node" -v)" == "v$node_version"
check "runtime is root-owned" mode_is "/opt/layer/node/$node_version" "755 root:root"
check "no group/world-writable runtime files" no_writable_node_files

echo "Users and directories"
check "layer user has no login shell" test "$(getent passwd layer | cut -d: -f7)" == /usr/sbin/nologin
check "layer-apps group exists" getent group layer-apps
check "/opt/layer 755 root:root" mode_is /opt/layer "755 root:root"
check "/opt/layer/tools 755 root:root" mode_is /opt/layer/tools "755 root:root"
check "/etc/layer 750 root:layer" mode_is /etc/layer "750 root:layer"
check "/etc/layer/apps 755 root:root" mode_is /etc/layer/apps "755 root:root"
check "/var/lib/layer 700 layer:layer" mode_is /var/lib/layer "700 layer:layer"
check "/var/log/layer 700 root:root" mode_is /var/log/layer "700 root:root"
check "/srv/apps 711 root:root" mode_is /srv/apps "711 root:root"
check "/srv/static 711 root:root" mode_is /srv/static "711 root:root"

echo "Services"
check "caddy active" active caddy
check "fail2ban active" active fail2ban
check "fail2ban sshd jail watches ssh.service and sshd-session" \
  grep -q "sshd-session" <<<"$(fail2ban-client get sshd journalmatch)"
check "unattended-upgrades enabled" grep -q 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades
check "caddy apt key pinned" test -s /usr/share/keyrings/caddy-stable-archive-keyring.gpg
check "caddy admin API on a private unix socket" test -S /run/caddy/admin.sock
check "/run/caddy is 700 caddy" mode_is /run/caddy "700 caddy:caddy"
check "nothing listens on localhost:2019" bash -c '! (exec 3<>/dev/tcp/127.0.0.1/2019) 2>/dev/null'
check "caddy imports /etc/caddy/sites" grep -q "^import /etc/caddy/sites/\*.caddy" /etc/caddy/Caddyfile

echo "Panel and agent"
panel_host="$(awk 'NF && $1 !~ /^#/ {print $1; exit}' /etc/caddy/sites/_panel.caddy 2>/dev/null)"
check "layer-agent active" active layer-agent
check "layer-panel active" active layer-panel
check "agent socket 660 root:layer" mode_is /run/layer/agent.sock "660 root:layer"
check "panel socket 660 layer:layer-web" mode_is /run/layer-panel/panel.sock "660 layer:layer-web"
check "caddy can reach the panel" runuser -u caddy -- curl -fsS --unix-socket /run/layer-panel/panel.sock http://panel/api/health
check "other users can't reach the panel socket" bash -c '! runuser -u nobody -- curl -fsS --unix-socket /run/layer-panel/panel.sock http://panel/api/health'
panel_pid="$(systemctl show -p MainPID --value layer-panel)"
check "panel doesn't listen on any TCP port" bash -c "! ss -Hltnp | grep -q 'pid=$panel_pid,'"
check "panel serves over HTTPS through Caddy ($panel_host)" \
  bash -c "curl -sk -o /dev/null -w '%{http_code}' --resolve '$panel_host:443:127.0.0.1' 'https://$panel_host/api/health' | grep -q 200"
check "secret key 640 root:layer" mode_is /etc/layer/secret.key "640 root:layer"
check "config.json 640 root:layer" mode_is /etc/layer/config.json "640 root:layer"
check "config.json names the apps domain" bash -c "jq -e '.appsDomain | endswith(\".sslip.io\")' /etc/layer/config.json"
panel_db_ok() { [[ ! -e /var/lib/layer/panel.db ]] || mode_is /var/lib/layer/panel.db "600 layer:layer-web"; }
check "panel DB is private to layer" panel_db_ok
check "layer CLI works" layer info

echo "Memory"
check "swap on (or RAM >= 4GB)" swap_ok
check "vm.swappiness = 10" test "$(sysctl -n vm.swappiness)" == 10

echo "Firewall"
check "ufw active" grep -q "Status: active" <<<"$(ufw status)"
check "ufw allows 80/tcp" ufw_allows 80/tcp
check "ufw allows 443/tcp" ufw_allows 443/tcp
check "ufw allows 443/udp" ufw_allows 443/udp

if ((expect_ssh_hardened)); then
  echo "SSH"
  check "password login off" sshd_says "passwordauthentication no"
  check "keyboard-interactive off" sshd_says "kbdinteractiveauthentication no"
fi

echo
if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "All checks passed"

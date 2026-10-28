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
check "/etc/layer 750 root:layer" mode_is /etc/layer "750 root:layer"
check "/etc/layer/apps 755 root:root" mode_is /etc/layer/apps "755 root:root"
check "/var/lib/layer 700 layer:layer" mode_is /var/lib/layer "700 layer:layer"
check "/var/log/layer 700 root:root" mode_is /var/log/layer "700 root:root"
check "/srv/apps 711 root:root" mode_is /srv/apps "711 root:root"

echo "Services"
check "caddy active" active caddy
check "fail2ban active" active fail2ban
check "fail2ban sshd jail watches ssh.service and sshd-session" \
  grep -q "sshd-session" <<<"$(fail2ban-client get sshd journalmatch)"
check "unattended-upgrades enabled" grep -q 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades
check "caddy apt key pinned" test -s /usr/share/keyrings/caddy-stable-archive-keyring.gpg

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

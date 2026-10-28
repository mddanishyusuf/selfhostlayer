# shellcheck shell=bash
# Step 1: refuse to touch boxes we can't support, before changing anything.

MIN_DISK_GB=10
# A re-run (repair) only needs room for package updates. The first run's swap
# file alone takes 2GB.
MIN_DISK_GB_RERUN=2

preflight() {
  step "Checking this server"
  preflight_root
  preflight_os
  preflight_arch
  preflight_systemd
  preflight_ports
  preflight_disk
  preflight_public_ip
}

preflight_root() {
  [[ "$(id -u)" -eq 0 ]] || die "run as root (try: curl -fsSL https://get.selfhostlayer.com | sudo bash)"
}

preflight_os() {
  [[ -r /etc/os-release ]] || die "can't read /etc/os-release"
  local id version
  id="$(. /etc/os-release && printf '%s' "${ID:-}")"
  version="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
  case "$id:$version" in
    ubuntu:24.04 | ubuntu:26.04 | debian:12) ok "OS: $id $version" ;;
    *) die "unsupported OS: $id $version (supported: Ubuntu 24.04, 26.04, Debian 12)" ;;
  esac
}

preflight_arch() {
  # LAYER_NODE_ARCH is read by node.sh.
  # shellcheck disable=SC2034
  case "$(uname -m)" in
    x86_64) LAYER_NODE_ARCH="x64" ;;
    aarch64) LAYER_NODE_ARCH="arm64" ;;
    *) die "unsupported CPU architecture: $(uname -m) (supported: x86_64, aarch64)" ;;
  esac
  ok "Architecture: $(uname -m)"
}

preflight_systemd() {
  [[ "$(cat /proc/1/comm 2>/dev/null)" == systemd ]] || die "systemd is not PID 1 (containers and WSL aren't supported)"
  ok "systemd $(systemctl --version | awk 'NR==1 {print $2}')"
}

preflight_ports() {
  local port owner
  for port in 80 443; do
    owner="$(ss -Hltnp "sport = :$port" 2>/dev/null | grep -o 'users:(("[^"]*' | cut -d'"' -f2 | head -1 || true)"
    if [[ -n "$owner" && "$owner" != caddy ]]; then
      die "port $port is already used by '$owner'. Stop it first (e.g. systemctl disable --now $owner)"
    fi
  done
  ok "Ports 80 and 443 are free"
}

preflight_disk() {
  local free_gb need_gb=$MIN_DISK_GB
  [[ -d /opt/layer/node ]] && need_gb=$MIN_DISK_GB_RERUN
  free_gb="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
  ((free_gb >= need_gb)) || die "only ${free_gb}GB free on /, need at least ${need_gb}GB"
  ok "Disk: ${free_gb}GB free"
}

preflight_public_ip() {
  LAYER_PUBLIC_IP="$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [[ ! "$LAYER_PUBLIC_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    LAYER_PUBLIC_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')"
  fi
  [[ -n "$LAYER_PUBLIC_IP" ]] || die "couldn't detect the public IPv4 address (pass --domain instead)"
  ok "Public IP: $LAYER_PUBLIC_IP"
}

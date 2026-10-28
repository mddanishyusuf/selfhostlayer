# shellcheck shell=bash
# Step 2: system packages, the Caddy apt repo, unattended-upgrades, fail2ban.

CADDY_KEY_URL="https://dl.cloudsmith.io/public/caddy/stable/gpg.key"
CADDY_KEY_FPR="65760C51EDEA2017CEA2CA15155B6D79CA56EA34"
CADDY_KEYRING="/usr/share/keyrings/caddy-stable-archive-keyring.gpg"
CADDY_LIST="/etc/apt/sources.list.d/caddy-stable.list"

PACKAGES=(
  ca-certificates curl gnupg xz-utils unzip jq sqlite3
  ufw fail2ban python3-systemd unattended-upgrades
  caddy
)

apt_get() {
  # Fresh cloud boxes often run apt in cloud-init or unattended-upgrades right
  # after boot. Wait for the lock instead of failing.
  run env DEBIAN_FRONTEND=noninteractive apt-get -q -y \
    -o DPkg::Lock::Timeout=300 \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
    "$@"
}

install_packages() {
  step "Installing packages"
  caddy_repo
  apt_get update
  apt_get install --no-install-recommends "${PACKAGES[@]}"
  ok "Packages: ${PACKAGES[*]}"
  ok "Caddy $(caddy version | awk '{print $1}')"
  auto_upgrades
  fail2ban_sshd
}

caddy_repo() {
  if [[ -s "$CADDY_KEYRING" && -s "$CADDY_LIST" ]]; then
    info "Caddy apt repo already configured"
    return
  fi
  # gnupg is needed to check the key before the main install runs.
  if ! command -v gpg >/dev/null; then
    apt_get update
    apt_get install --no-install-recommends gnupg
  fi
  local tmp fpr
  tmp="$(mktemp)"
  curl -fsSL "$CADDY_KEY_URL" -o "$tmp" || die "couldn't download the Caddy signing key"
  fpr="$(gpg --show-keys --with-colons "$tmp" 2>/dev/null | awk -F: '$1 == "fpr" {print $10; exit}')"
  if [[ "$fpr" != "$CADDY_KEY_FPR" ]]; then
    rm -f "$tmp"
    die "Caddy signing key fingerprint mismatch (got '$fpr', expected $CADDY_KEY_FPR)"
  fi
  gpg --dearmor <"$tmp" >"$CADDY_KEYRING.tmp" && mv "$CADDY_KEYRING.tmp" "$CADDY_KEYRING"
  chmod 644 "$CADDY_KEYRING"
  rm -f "$tmp"
  printf 'deb [signed-by=%s] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main\n' \
    "$CADDY_KEYRING" >"$CADDY_LIST"
  ok "Caddy apt repo added (key $CADDY_KEY_FPR)"
}

auto_upgrades() {
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  run systemctl enable --now unattended-upgrades
  ok "Unattended security upgrades on"
}

fail2ban_sshd() {
  # The systemd backend works on Debian 12 too, which has no /var/log/auth.log.
  # Ubuntu/Debian name the unit ssh.service (fail2ban's default looks for
  # sshd.service), and OpenSSH 10+ logs auth failures from sshd-session.
  # fail2ban reads jail.d/ alphabetically and the last value wins, so "zz-"
  # sorts after Debian's defaults-debian.conf, which sets journalmatch on 26.04.
  rm -f /etc/fail2ban/jail.d/10-layer.conf
  cat >/etc/fail2ban/jail.d/zz-layer.conf <<'EOF'
# Managed by Self Host Layer.
[sshd]
enabled = true
backend = systemd
journalmatch = _SYSTEMD_UNIT=ssh.service + _SYSTEMD_UNIT=sshd.service + _COMM=sshd + _COMM=sshd-session
maxretry = 5
findtime = 10m
bantime = 1h
EOF
  run systemctl enable fail2ban
  run systemctl restart fail2ban
  ok "fail2ban guarding SSH"
}

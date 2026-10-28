# shellcheck shell=bash
# Step 9: ufw. Only SSH, HTTP and HTTPS (plus HTTP/3 over UDP) are reachable.

setup_firewall() {
  step "Configuring the firewall"
  local config ssh_port
  config="$(sshd_effective_config || true)"
  ssh_port="$(awk '$1 == "port" {print $2; exit}' <<<"$config")"
  ssh_port="${ssh_port:-22}"

  run ufw default deny incoming
  run ufw default allow outgoing
  # Allow SSH before enabling, so the current session survives.
  run ufw allow "$ssh_port/tcp" comment "ssh"
  run ufw allow 80/tcp comment "http"
  run ufw allow 443/tcp comment "https"
  run ufw allow 443/udp comment "http3"
  run ufw --force enable
  ok "ufw on: allow $ssh_port/tcp (ssh), 80/tcp, 443/tcp, 443/udp"
}

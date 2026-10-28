# shellcheck shell=bash
# Step 10: SSH keys only. Never lock the owner out: this only runs when an
# authorized key exists for root or a sudo user, and the user agrees.

SSH_DROPIN=/etc/ssh/sshd_config.d/10-layer.conf

harden_ssh() {
  step "Hardening SSH"
  if [[ "$LAYER_HARDEN_SSH" != 1 ]]; then
    info "Skipped (--no-harden-ssh)"
    return
  fi
  if ssh_already_hardened; then
    ok "Password login is already off"
    return
  fi

  local key_owners
  key_owners="$(ssh_key_owners)"
  if [[ -z "$key_owners" ]]; then
    info "Skipped: no SSH key found for root or a sudo user."
    info "Add your key to ~/.ssh/authorized_keys and re-run the installer to turn off password login."
    return
  fi
  info "SSH keys found for: $key_owners"
  if ! confirm "Turn off SSH password login? Keep this session open and test a new key login after."; then
    info "Skipped. Re-run with --yes to turn off password login without asking."
    return
  fi

  # sshd uses the first value it reads, and the 10- prefix sorts before the
  # cloud images' 50-cloud-init.conf and 60-cloudimg-settings.conf.
  cat >"$SSH_DROPIN" <<'EOF'
# Managed by Self Host Layer: SSH keys only.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  chmod 644 "$SSH_DROPIN"
  if ! sshd -t 2>>"$LAYER_LOG"; then
    rm -f "$SSH_DROPIN"
    die "sshd rejected the new config, so it was removed and nothing changed (see $LAYER_LOG)"
  fi
  # ssh.service may be socket-activated (Ubuntu 24.04+); the next connection
  # picks up the config either way.
  run systemctl try-reload-or-restart ssh.service
  ssh_already_hardened || die "password login is still on after the change (check $SSH_DROPIN)"
  ok "Password login off. Keys only, root login by key only"
}

# Prints sshd's effective settings. Capture this into a variable before
# parsing: piping into a reader that exits early (awk exit, grep -q) makes
# sshd die of SIGPIPE, which fails the pipeline under pipefail.
sshd_effective_config() {
  # sshd -T needs its privilege separation dir, which socket-activated
  # Ubuntu 24.04+ only creates on the first connection.
  install -d -m 755 /run/sshd
  sshd -T 2>/dev/null
}

ssh_already_hardened() {
  local config
  config="$(sshd_effective_config)" || return 1
  grep -qx "passwordauthentication no" <<<"$config" &&
    grep -qx "kbdinteractiveauthentication no" <<<"$config"
}

# Prints the users (root or sudo/wheel members) who have at least one key.
ssh_key_owners() {
  local users=(root) extra=() owners=() user home sudoers
  # getent exits 2 when a group (usually wheel) doesn't exist.
  sudoers="$({ getent group sudo wheel 2>/dev/null || true; } | cut -d: -f4 | tr ',\n' '  ')"
  read -r -a extra <<<"$sudoers"
  users+=("${extra[@]}")
  for user in "${users[@]}"; do
    [[ -n "$user" ]] || continue
    home="$(getent passwd "$user" | cut -d: -f6)"
    [[ -n "$home" && -f "$home/.ssh/authorized_keys" ]] || continue
    if grep -qE '^[^#]*(ssh-ed25519|ssh-rsa|ecdsa-sha2-|sk-ssh-ed25519|sk-ecdsa-sha2-)' "$home/.ssh/authorized_keys"; then
      owners+=("$user")
    fi
  done
  printf '%s' "${owners[*]}"
}

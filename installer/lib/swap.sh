# shellcheck shell=bash
# Step 3: swap on small boxes, so `next build` can't OOM-kill the server.

SWAP_BELOW_MB=4096
SWAP_FILE=/swapfile
SWAP_SIZE_MB=2048

setup_swap() {
  step "Checking swap"
  local mem_mb swap_mb
  mem_mb="$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo)"
  swap_mb="$(awk '/^SwapTotal:/ {print int($2 / 1024)}' /proc/meminfo)"

  cat >/etc/sysctl.d/90-layer.conf <<'EOF'
# Managed by Self Host Layer: use swap only under real memory pressure.
vm.swappiness = 10
EOF
  run sysctl -q -p /etc/sysctl.d/90-layer.conf

  if ((swap_mb > 0)); then
    ok "Swap already on (${swap_mb}MB, RAM ${mem_mb}MB)"
    return
  fi
  if ((mem_mb >= SWAP_BELOW_MB)); then
    ok "RAM ${mem_mb}MB, no swap needed"
    return
  fi

  if [[ ! -f "$SWAP_FILE" ]]; then
    fallocate -l "${SWAP_SIZE_MB}M" "$SWAP_FILE" 2>/dev/null ||
      run dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$SWAP_SIZE_MB" status=none
    chmod 600 "$SWAP_FILE"
    run mkswap "$SWAP_FILE"
  fi
  run swapon "$SWAP_FILE"
  grep -qE "^$SWAP_FILE\s" /etc/fstab || printf '%s none swap sw 0 0\n' "$SWAP_FILE" >>/etc/fstab
  ok "Added ${SWAP_SIZE_MB}MB swap at $SWAP_FILE (RAM ${mem_mb}MB)"
}

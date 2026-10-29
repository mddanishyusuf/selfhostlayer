#!/usr/bin/env bash
# The idle budget: panel + agent + Caddy use at most 200MB at rest. It's the
# headline number against Docker panels, so CI fails above it. Measured as PSS
# (each process's share of the memory it maps; page cache isn't counted), after
# the panel has served its sign-in page: an idle panel, not one never opened.
# Run as root after install.sh:
#   sudo bash installer/test/idle-budget.sh [budget-mb]
set -euo pipefail

budget="${1:-200}"
host="$(jq -r .panelHost /etc/layer/config.json)"
for _ in 1 2 3; do
  curl -sk -o /dev/null --max-time 20 --resolve "$host:443:127.0.0.1" "https://$host/login" || true
done
sleep "${IDLE_WAIT:-20}"

total=0
printf '%-12s %5s %9s\n' unit procs pss
for unit in layer-panel layer-agent caddy; do
  # cgroup files always report a size of 0: read them to see if they're empty.
  pids="$(cat "/sys/fs/cgroup/system.slice/$unit.service/cgroup.procs" 2>/dev/null || true)"
  [[ -n "$pids" ]] || { echo "$unit isn't running" >&2; exit 1; }
  kb=0
  n=0
  for pid in $pids; do
    pss="$(awk '/^Pss:/ {print $2}' "/proc/$pid/smaps_rollup" 2>/dev/null || true)"
    kb=$((kb + ${pss:-0}))
    n=$((n + 1))
  done
  printf '%-12s %5d %7dMB\n' "$unit" "$n" $((kb / 1024))
  total=$((total + kb))
done
mb=$((total / 1024))
printf '%-12s %5s %7dMB of %dMB\n' total "" "$mb" "$budget"
if ((mb > budget)); then
  echo "Over the idle budget by $((mb - budget))MB"
  exit 1
fi
echo "Within the idle budget"

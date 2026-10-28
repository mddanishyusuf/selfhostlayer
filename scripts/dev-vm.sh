#!/usr/bin/env bash
# Local Ubuntu VM for testing on macOS/Linux, via Multipass (brew install --cask multipass).
#
#   scripts/dev-vm.sh up       # create the VM (2 CPU, 2GB RAM: a small VPS)
#   scripts/dev-vm.sh spike    # run spike/next-sandbox.sh inside it
#   scripts/dev-vm.sh install  # build dist/install.sh and run it inside the VM
#   scripts/dev-vm.sh shell    # open a shell in the VM
#   scripts/dev-vm.sh reset    # destroy and recreate it (a fresh box)
#   scripts/dev-vm.sh down     # destroy it
#
# Override with env vars: LAYER_VM (name), LAYER_VM_IMAGE (24.04 | 26.04).
set -euo pipefail

vm="${LAYER_VM:-layer-dev}"
image="${LAYER_VM_IMAGE:-24.04}"
spike_node="24.13.1"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v multipass >/dev/null || { echo "multipass not found: brew install --cask multipass" >&2; exit 1; }

exists() { multipass info "$vm" >/dev/null 2>&1; }

up() {
  if exists; then
    multipass start "$vm"
  else
    # 15G is a sparse image: it only uses what the VM writes (a few GB).
    multipass launch "$image" --name "$vm" --cpus 2 --memory 2G --disk 15G
  fi
  multipass info "$vm" | grep -E '^(Name|State|IPv4|Release)'
}

spike() {
  exists || up
  local unit
  unit="$(mktemp -d)/app-hello@.service"
  node "$root/agent/scripts/render-unit.ts" --slug hello --node "$spike_node" --write .next/cache \
    -- node node_modules/next/dist/bin/next start -H 127.0.0.1 >"$unit"
  multipass transfer "$root/spike/next-sandbox.sh" "$unit" "$vm:/home/ubuntu/"
  multipass exec "$vm" -- sudo bash /home/ubuntu/next-sandbox.sh /home/ubuntu/app-hello@.service
}

install() {
  exists || up
  bash "$root/scripts/build-installer.sh" dev >/dev/null
  multipass transfer "$root/dist/install.sh" "$vm:/home/ubuntu/install.sh"
  multipass exec "$vm" -- sudo bash /home/ubuntu/install.sh "$@"
}

case "${1:-}" in
  up) up ;;
  spike) spike ;;
  install) shift; install "$@" ;;
  shell) multipass shell "$vm" ;;
  reset) multipass delete --purge "$vm" 2>/dev/null || true; up ;;
  down) multipass delete --purge "$vm" ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

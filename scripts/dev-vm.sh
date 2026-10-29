#!/usr/bin/env bash
# Local Ubuntu VM for testing on macOS/Linux, via Multipass (brew install --cask multipass).
#
#   scripts/dev-vm.sh up       # create the VM (2 CPU, 2GB RAM: a small VPS)
#   scripts/dev-vm.sh spike    # run spike/next-sandbox.sh inside it
#   scripts/dev-vm.sh verify   # check the server state the installer promises
#   scripts/dev-vm.sh release  # build the release tarball, run the real installer with it
#   scripts/dev-vm.sh e2e      # agent, blue/green and build end-to-end tests in the VM
#   scripts/dev-vm.sh ui       # browser tour of the VM's panel (screenshots in dist/screenshots)
#   scripts/dev-vm.sh lint     # shellcheck all scripts inside the VM
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
    # 20G is a sparse image: it only uses what the VM writes (a few GB).
    multipass launch "$image" --name "$vm" --cpus 2 --memory 2G --disk 20G
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

# Lints every script inside the VM (no local shellcheck or Docker needed).
lint() {
  exists || up
  bash "$root/scripts/build-installer.sh" dev >/dev/null
  local archive
  archive="$(mktemp -d)/layer-lint.tgz"
  (cd "$root" && COPYFILE_DISABLE=1 tar --no-xattrs -czf "$archive" installer scripts spike dist/install.sh)
  multipass transfer "$archive" "$vm:/home/ubuntu/layer-lint.tgz"
  multipass exec "$vm" -- sh -c '
    command -v shellcheck >/dev/null || sudo apt-get install -y -q shellcheck >/dev/null
    rm -rf /tmp/lint && mkdir /tmp/lint && cd /tmp/lint && tar xzf /home/ubuntu/layer-lint.tgz &&
    shellcheck --external-sources installer/install.sh installer/lib/*.sh installer/test/*.sh scripts/*.sh spike/*.sh dist/install.sh &&
    echo "shellcheck: clean"'
}

vm_ip() { multipass info "$vm" | awk '/IPv4/ {print $2; exit}'; }

# Builds the release tarball and runs the real installer with it. The panel is
# served at https://<vm-ip>.sslip.io with Caddy's local CA (the VM has no
# public IP for Let's Encrypt); apps get <slug>.internal URLs (also local CA).
# The setup token is saved for `ui`.
release() {
  exists || up
  bash "$root/scripts/build-installer.sh" dev >/dev/null
  bash "$root/scripts/build-release.sh" dev
  multipass transfer "$root/dist/install.sh" "$root/dist/layer-dev.tar.gz" "$vm:/home/ubuntu/"
  local host out
  host="$(vm_ip | tr . -).sslip.io"
  out="$(mktemp)"
  multipass exec "$vm" -- sudo bash /home/ubuntu/install.sh --from-tarball /home/ubuntu/layer-dev.tar.gz \
    --domain "$host" --internal-tls --apps-domain internal --yes "$@" | tee "$out"
  sed 's/\x1b\[[0-9;]*m//g' "$out" | awk '/Setup token:/ {print $NF}' >"$root/dist/vm-setup-token"
  echo "https://$host" >"$root/dist/vm-panel-url"
}

# Agent, blue/green and build end-to-end tests inside the VM.
e2e() {
  exists || up
  multipass transfer "$root/installer/test/agent-e2e.sh" "$root/installer/test/bluegreen-e2e.sh" \
    "$root/installer/test/build-e2e.sh" "$root/installer/test/cron-e2e.sh" "$vm:/home/ubuntu/"
  multipass exec "$vm" -- sudo bash /home/ubuntu/agent-e2e.sh
  multipass exec "$vm" -- sudo bash /home/ubuntu/bluegreen-e2e.sh
  multipass exec "$vm" -- sudo bash /home/ubuntu/build-e2e.sh
  multipass exec "$vm" -- sudo bash /home/ubuntu/cron-e2e.sh
}

# Drives Chrome on this machine through the VM's panel (setup → 2FA → sign in).
ui() {
  local url token
  url="$(cat "$root/dist/vm-panel-url")"
  token="$(cat "$root/dist/vm-setup-token")"
  [[ -n "$token" ]] || { echo "no setup token saved: run 'scripts/dev-vm.sh reset && scripts/dev-vm.sh release' first" >&2; exit 1; }
  node "$root/panel/scripts/ui-tour.ts" "$url" "$token" "$root/dist/screenshots"
}

verify() {
  exists || up
  multipass transfer "$root/installer/test/verify.sh" "$vm:/home/ubuntu/verify.sh"
  multipass exec "$vm" -- sudo bash /home/ubuntu/verify.sh "$@"
}

case "${1:-}" in
  up) up ;;
  spike) spike ;;
  lint) lint ;;
  verify) shift; verify "$@" ;;
  release) shift; release "$@" ;;
  e2e) e2e ;;
  ui) ui ;;
  install) shift; release "$@" ;; # older name for release
  shell) multipass shell "$vm" ;;
  reset) multipass delete --purge "$vm" 2>/dev/null || true; up ;;
  down) multipass delete --purge "$vm" ;;
  *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

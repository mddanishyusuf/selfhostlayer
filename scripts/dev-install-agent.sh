#!/usr/bin/env bash
# Installs a locally built agent on a box where install.sh already ran, and
# (re)starts it. Development and CI only: from Day 5 the installer does this.
#   sudo bash scripts/dev-install-agent.sh <layer-agent.mjs> <layer-agent.service> [node-version]
set -euo pipefail

bundle="${1:?usage: dev-install-agent.sh <layer-agent.mjs> <layer-agent.service> [node-version]}"
unit="${2:?missing layer-agent.service}"
node_version="${3:-24.13.1}"

[[ "$(id -u)" -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -x "/opt/layer/node/$node_version/bin/node" ]] || { echo "Node $node_version missing: run install.sh first" >&2; exit 1; }

install -d -m 755 /opt/layer/agent/releases/dev
install -m 644 "$bundle" /opt/layer/agent/releases/dev/layer-agent.mjs
ln -sfn releases/dev /opt/layer/agent/current
ln -sfn "node/$node_version" /opt/layer/runtime
install -m 644 "$unit" /etc/systemd/system/layer-agent.service
systemctl daemon-reload
systemctl enable --quiet layer-agent
systemctl restart layer-agent

for _ in $(seq 1 50); do
  [[ -S /run/layer/agent.sock ]] && break
  sleep 0.1
done
if [[ ! -S /run/layer/agent.sock ]]; then
  journalctl -u layer-agent -n 30 --no-pager
  echo "layer-agent didn't create its socket" >&2
  exit 1
fi
journalctl -u layer-agent -n 1 --no-pager -o cat

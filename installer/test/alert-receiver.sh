#!/usr/bin/env bash
# Test helper (VM only): a webhook receiver at https://hook.internal that
# records every POST and lists them at /log, and makes the panel trust
# Caddy's local CA so it can post there. Undo with --remove.
#   sudo bash installer/test/alert-receiver.sh [--remove]
set -euo pipefail

dropin=/etc/systemd/system/layer-panel.service.d/zz-test-ca.conf
site=/etc/caddy/sites/zz-test-hook.caddy

if [[ "${1:-}" == --remove ]]; then
  systemctl stop layer-test-hook 2>/dev/null || true
  rm -f "$dropin" "$site" /etc/layer/test-ca.crt /root/layer-test-hook.js /tmp/layer-hooks.jsonl
  systemctl daemon-reload
  systemctl reload caddy
  systemctl restart layer-panel
  echo "removed"
  exit 0
fi

cat >/root/layer-test-hook.js <<'JS'
const http = require("node:http");
const fs = require("node:fs");
const file = "/tmp/layer-hooks.jsonl";
http
  .createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        // One raw JSON body per line (the signature header is checked by unit tests).
        fs.appendFileSync(file, body + "\n");
        res.end("ok");
      });
      return;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(fs.existsSync(file) ? fs.readFileSync(file) : "");
  })
  .listen(4998, "127.0.0.1");
JS
: >/tmp/layer-hooks.jsonl
systemctl stop layer-test-hook 2>/dev/null || true
systemctl reset-failed layer-test-hook 2>/dev/null || true
systemd-run --quiet --unit=layer-test-hook /opt/layer/runtime/bin/node /root/layer-test-hook.js
printf 'hook.internal {\n\treverse_proxy 127.0.0.1:4998\n}\n' >"$site"
systemctl reload caddy

# Caddy creates its local CA with the first internal certificate.
ca=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
for _ in $(seq 1 30); do
  curl -sk --resolve hook.internal:443:127.0.0.1 -o /dev/null https://hook.internal/log && [[ -f "$ca" ]] && break
  sleep 1
done
install -m 644 "$ca" /etc/layer/test-ca.crt
mkdir -p "$(dirname "$dropin")"
printf '[Service]\nEnvironment=NODE_EXTRA_CA_CERTS=/etc/layer/test-ca.crt\n' >"$dropin"
grep -q "hook.internal" /etc/hosts || echo "127.0.0.1 hook.internal" >>/etc/hosts
systemctl daemon-reload
systemctl restart layer-panel
for _ in $(seq 1 60); do
  runuser -u caddy -- curl -fsS --unix-socket /run/layer-panel/panel.sock http://panel/api/health >/dev/null 2>&1 && break
  sleep 0.5
done
echo "receiver ready at https://hook.internal (log: /log)"

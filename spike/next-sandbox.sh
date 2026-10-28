#!/usr/bin/env bash
# Day 1 spike: prove a real Next.js app builds and runs inside the generated
# sandboxed unit. Run as root on a THROWAWAY Ubuntu 24.04/26.04 box.
#
#   # on your machine
#   node agent/scripts/render-unit.ts --slug hello --node 24.13.1 --write .next/cache \
#     -- node node_modules/next/dist/bin/next start -H 127.0.0.1 > /tmp/app-hello@.service
#   scp spike/next-sandbox.sh /tmp/app-hello@.service root@<box>:
#   ssh root@<box> bash next-sandbox.sh app-hello@.service
#
# Re-run with --cleanup to remove everything it created.
set -Eeuo pipefail

slug=hello
user="app-$slug"
app_dir="/srv/apps/$slug"
etc_dir="/etc/layer/apps/$slug"
release="$app_dir/releases/spike"
port=4001

say() { printf '\n\e[1m==> %s\e[0m\n' "$*"; }
die() { printf '\e[31merror:\e[0m %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "run as root"

if [[ "${1:-}" == --cleanup ]]; then
  systemctl stop "app-$slug@blue" 2>/dev/null || true
  rm -f "/etc/systemd/system/app-$slug@.service"
  systemctl daemon-reload
  userdel "$user" 2>/dev/null || true
  rm -rf "$app_dir" "$etc_dir"
  echo "cleaned up (Node in /opt/layer/node is kept)"
  exit 0
fi

unit_file="${1:?usage: next-sandbox.sh <app-hello@.service> | --cleanup}"
[[ -f "$unit_file" ]] || die "unit file not found: $unit_file"
node_version="$(grep -oE '/opt/layer/node/[0-9]+\.[0-9]+\.[0-9]+' "$unit_file" | head -1 | cut -d/ -f5)"
[[ -n "$node_version" ]] || die "couldn't find the Node version in $unit_file"
node_dir="/opt/layer/node/$node_version"

say "Node $node_version → $node_dir"
if [[ ! -x "$node_dir/bin/node" ]]; then
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) die "unsupported arch $(uname -m)" ;;
  esac
  tarball="node-v$node_version-linux-$arch.tar.xz"
  tmp="$(mktemp -d)"
  curl -fsSLo "$tmp/$tarball" "https://nodejs.org/dist/v$node_version/$tarball"
  curl -fsSLo "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$node_version/SHASUMS256.txt"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -) || die "checksum mismatch"
  mkdir -p "$node_dir"
  tar -xJf "$tmp/$tarball" -C "$node_dir" --strip-components=1 --no-same-owner
  rm -rf "$tmp"
fi
"$node_dir/bin/node" -v

say "App user $user"
id "$user" &>/dev/null || useradd --system --shell /usr/sbin/nologin --home "$app_dir" "$user"
mkdir -p "$release/app/api/sandbox" "$app_dir/data"

cat >"$release/package.json" <<'EOF'
{
  "private": true,
  "scripts": { "build": "next build" },
  "dependencies": { "next": "latest", "react": "latest", "react-dom": "latest" }
}
EOF
cat >"$release/app/layout.js" <<'EOF'
export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}</body></html>;
}
EOF
cat >"$release/app/page.js" <<'EOF'
export const dynamic = "force-dynamic";
export default function Page() {
  return <h1>hello from a sandboxed unit on port {process.env.PORT}</h1>;
}
EOF
# Each probe reports what the sandbox allowed. Expected results are in the JSON keys.
cat >"$release/app/api/sandbox/route.js" <<'EOF'
import fs from "node:fs";
import os from "node:os";
export const dynamic = "force-dynamic";
function probe(fn) {
  try { return { ok: true, value: fn() ?? null }; } catch (e) { return { ok: false, error: e.code ?? e.message }; }
}
export function GET() {
  return Response.json({
    whoami: probe(() => os.userInfo().username),
    writeData_expectOk: probe(() => fs.writeFileSync("/srv/apps/hello/data/probe.txt", "x")),
    writeNextCache_expectOk: probe(() => fs.writeFileSync(".next/cache/probe.txt", "x")),
    writeRelease_expectFail: probe(() => fs.writeFileSync("probe.txt", "x")),
    writeEtc_expectFail: probe(() => fs.writeFileSync("/etc/probe.txt", "x")),
    readShadow_expectFail: probe(() => fs.readFileSync("/etc/shadow", "utf8").length),
    readRoot_expectFail: probe(() => fs.readdirSync("/root")),
    writeTmp_expectOk: probe(() => fs.writeFileSync("/tmp/probe.txt", "x")),
    cpus_expectNonZero: probe(() => os.cpus().length),
    networkInterfaces_expectOk: probe(() => Object.keys(os.networkInterfaces())),
    otherProcesses_expectHidden: probe(() => fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p)).length),
  });
}
EOF
chown -R "$user:$user" "$app_dir"
chmod 750 "$app_dir"
chmod 700 "$app_dir/data"

say "Build as $user, sandboxed (transient unit, 1GB memory cap)"
build_start=$(date +%s)
systemd-run --quiet --wait --pipe --collect \
  --unit="layer-build-$slug" \
  --uid="$user" --gid="$user" \
  -p WorkingDirectory="$release" \
  -p MemoryMax=1G -p MemorySwapMax=2G \
  -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes \
  -p ReadWritePaths="$app_dir" \
  -E HOME="$app_dir" -E PATH="$node_dir/bin:/usr/bin:/bin" -E NEXT_TELEMETRY_DISABLED=1 \
  /bin/sh -c 'npm install --no-audit --no-fund --loglevel=error && npm run build'
echo "build took $(($(date +%s) - build_start))s"
# .next/cache must exist for the runtime ReadWritePaths entry to apply.
install -d -o "$user" -g "$user" -m 700 "$release/.next/cache"
ln -sfn "$release" "$app_dir/blue"

say "Env files in $etc_dir"
install -d -m 755 "$etc_dir"
install -m 600 /dev/null "$etc_dir/app.env"
printf 'PORT=%s\nHOSTNAME=127.0.0.1\nNODE_ENV=production\nNEXT_TELEMETRY_DISABLED=1\n' "$port" >"$etc_dir/blue.env"
chmod 644 "$etc_dir/blue.env"

say "Start app-$slug@blue"
install -m 644 "$unit_file" "/etc/systemd/system/app-$slug@.service"
systemctl daemon-reload
systemctl restart "app-$slug@blue"
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$port/" >/dev/null 2>&1 && break
  sleep 1
done
systemctl is-active --quiet "app-$slug@blue" || {
  journalctl -u "app-$slug@blue" -n 50 --no-pager
  die "app-$slug@blue failed to start"
}

say "GET /"
curl -fsS "http://127.0.0.1:$port/" | grep -o '<h1>.*</h1>' || die "page didn't render"

say "GET /api/sandbox"
curl -fsS "http://127.0.0.1:$port/api/sandbox" | "$node_dir/bin/node" -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0, "utf8")), null, 2))'

say "Resources"
systemctl show "app-$slug@blue" -p MemoryCurrent -p MemoryMax -p TasksCurrent -p NRestarts

say "Blocked syscalls / errors in the journal"
journalctl -u "app-$slug@blue" --no-pager -o cat | grep -iE 'EPERM|SIGSYS|not permitted|error' || echo "none"

say "Safety score"
systemd-analyze security "app-$slug@blue" --no-pager | tail -1

printf '\nDone. Paste everything from "==> GET /api/sandbox" down back to Claude.\n'

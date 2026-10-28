#!/usr/bin/env bash
# Week 2 Day 2 "done when": every example in github.com/mddanishyusuf/selfhostlayer-examples
# is fetched from its GitHub tarball and built in the sandbox as its own app user;
# the server apps start and pass their health check; the broken one fails
# cleanly; builds can't escape the sandbox; timeout, cancel, prune and cache
# cleanup work. Run as root after install.sh (it creates/deletes apps named ex-*).
#   sudo bash installer/test/build-e2e.sh
# SC2015: `[[ check ]] && pass || fail` is intended (pass never fails).
# SC2016: build commands are single-quoted on purpose; they expand in the sandbox.
# shellcheck disable=SC2015,SC2016
set -uo pipefail

sock=/run/layer/agent.sock
node_version="${LAYER_NODE_DEFAULT:-24.13.1}"
bun_version=1.3.9
owner=mddanishyusuf
repo=selfhostlayer-examples
work="$(mktemp -d)"
failures=0
n=0

command -v socat >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q socat >/dev/null

pass() { printf '  \e[32m✓\e[0m %s\n' "$1"; }
fail() {
  printf '  \e[31m✗\e[0m %s\n' "$1"
  [[ -n "${2:-}" ]] && printf '%s\n' "$2" | head -20 | sed 's/^/      /'
  failures=$((failures + 1))
}
# call <action> <params>: prints only the final response line; streamed chunks go to $work/last.log.
call() {
  local params="${2:-}"
  [[ -n "$params" ]] || params='{}'
  n=$((n + 1))
  # Own files per call: a build may run in the background while we call build.cancel.
  local raw
  raw="$(mktemp -p "$work")"
  jq -nc --arg id "b$n-$RANDOM" --arg a "$1" --argjson p "$params" '{id: $id, action: $a, params: $p}' |
    runuser -u layer -- socat -t 3600 - "UNIX-CONNECT:$sock" >"$raw"
  jq -r 'select(.chunk) | .chunk' "$raw" | tr -d '\r' >"$raw.log"
  cp "$raw.log" "$work/last.log"
  grep -av '"chunk"' "$raw" | tail -1
}
expect() { if jq -e "$3" >/dev/null 2>&1 <<<"$2"; then pass "$1"; else fail "$1" "$2"$'\n'"$(tail -15 "$work/last.log")"; fi; }
log_has() { if grep -qF -- "$2" "$work/last.log"; then pass "$1"; else fail "$1" "$(tail -15 "$work/last.log")"; fi; }

sha="$(curl -fsS "https://api.github.com/repos/$owner/$repo/commits/main" | jq -r .sha)"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "couldn't resolve $owner/$repo main"; exit 1; }
echo "Examples at $owner/$repo@${sha:0:7}"

examples=(next vite express astro nuxt broken)
for ex in "${examples[@]}"; do call app.delete "{\"slug\":\"ex-$ex\",\"keepData\":false}" >/dev/null; done

echo "Tools"
expect "tool.install bun $bun_version" "$(call tool.install "{\"tool\":\"bun\",\"version\":\"$bun_version\"}")" '.ok'
expect "bun runs" "\"$("/opt/layer/tools/bun/$bun_version/bun" --version 2>&1)\"" ". == \"$bun_version\""

# fetch_and_build <example> <package manager> <build command or "">
fetch_and_build() {
  local ex="$1" pm="$2" build_cmd="$3" t=$SECONDS
  call app.create "{\"slug\":\"ex-$ex\"}" >/dev/null
  local res
  res="$(call source.fetch "$(jq -nc --arg s "ex-$ex" --arg o "$owner" --arg r "$repo" --arg sha "$sha" '{slug: $s, owner: $o, repo: $r, sha: $sha}')")"
  expect "$ex: fetched from the GitHub tarball" "$res" '.ok and .result.fetched'
  local params
  params="$(jq -nc --arg s "ex-$ex" --arg sha "$sha" --arg node "$node_version" --arg pm "$pm" --arg dir "$ex" --arg b "$build_cmd" \
    '{slug: $s, sha: $sha, nodeVersion: $node, packageManager: $pm, rootDir: $dir} + (if $b == "" then {} else {buildCommand: $b} end)')"
  call build.run "$params" >"$work/$ex.result"
  cp "$work/last.log" "$work/$ex.log"
  echo "    ($ex took $((SECONDS - t))s)"
}

echo "Fetch and build every example"
fetch_and_build next npm "npm run build"
expect "next: built with npm" "$(cat "$work/next.result")" '.ok and ([.result.steps[].name] == ["install","build"])'
[[ -f "/srv/apps/ex-next/releases/$sha/next/.next/BUILD_ID" ]] && pass "next: .next/BUILD_ID exists" || fail "next: .next/BUILD_ID exists"

fetch_and_build vite pnpm "pnpm run build"
expect "vite: built with pnpm (corepack)" "$(cat "$work/vite.result")" '.ok'
[[ -f "/srv/apps/ex-vite/releases/$sha/vite/dist/index.html" ]] && pass "vite: dist/index.html exists" || fail "vite: dist/index.html exists" "$(tail -15 "$work/vite.log")"

fetch_and_build express yarn ""
expect "express: installed with yarn 1, no build step" "$(cat "$work/express.result")" '.ok and ([.result.steps[].name] == ["install"])'

fetch_and_build astro bun "bun run build"
expect "astro: built with bun" "$(cat "$work/astro.result")" '.ok'
[[ -f "/srv/apps/ex-astro/releases/$sha/astro/dist/server/entry.mjs" ]] && pass "astro: dist/server/entry.mjs exists" || fail "astro: entry.mjs exists" "$(tail -15 "$work/astro.log")"

fetch_and_build nuxt npm "npm run build"
expect "nuxt: built with npm" "$(cat "$work/nuxt.result")" '.ok'
grep -q "falling back to npm install" "$work/nuxt.log" && pass "nuxt: out-of-sync lockfile fell back to npm install, with a warning" || fail "nuxt: npm ci fallback" "$(head -20 "$work/nuxt.log")"
[[ -f "/srv/apps/ex-nuxt/releases/$sha/nuxt/.output/server/index.mjs" ]] && pass "nuxt: .output/server/index.mjs exists" || fail "nuxt: .output exists"

fetch_and_build broken npm "npm run build"
expect "broken: fails at the build step" "$(cat "$work/broken.result")" '.error.code == "build_failed"'
grep -q 'Could not resolve "./does-not-exist.js"' "$work/broken.log" && pass "broken: the real error is in the log" || fail "broken: error in log" "$(tail -15 "$work/broken.log")"

echo "Start the server apps from their builds"
# start_app <example> <health path> <exec json> [writable json]
start_app() {
  local ex="$1" health="$2" exec_json="$3" writable="${4:-[]}"
  local params
  params="$(jq -nc --arg s "ex-$ex" --arg node "$node_version" --arg dir "$ex" --argjson e "$exec_json" --argjson w "$writable" \
    '{slug: $s, nodeVersion: $node, rootDir: $dir, exec: $e, writablePaths: $w, memoryMaxMb: 256}')"
  call unit.write "$params" >/dev/null
  call release.point "{\"slug\":\"ex-$ex\",\"color\":\"blue\",\"sha\":\"$sha\"}" >/dev/null
  local res port
  res="$(call unit.start "{\"slug\":\"ex-$ex\",\"color\":\"blue\",\"healthPath\":\"$health\",\"timeoutSec\":90}")"
  expect "$ex: starts and passes its health check" "$res" '.ok and .result.healthy'
  port="$(jq -r '.result.port // empty' <<<"$res")"
  if [[ -n "$port" && "$(curl -s "127.0.0.1:$port$health")" == ok ]]; then pass "$ex: GET $health answers ok"; else fail "$ex: GET $health answers ok" "$(journalctl -u "app-ex-$ex@blue" -n 15 --no-pager -o cat)"; fi
}
start_app next /api/health '["node","node_modules/next/dist/bin/next","start","-H","127.0.0.1"]' '[".next/cache"]'
start_app express /health '["node","server.js"]'
start_app astro /api/health '["node","dist/server/entry.mjs"]'
start_app nuxt /api/health '["node",".output/server/index.mjs"]'

echo "The build sandbox"
# build_cmd <command>: runs a build of ex-express (already fetched) with a custom build command.
build_cmd() {
  call build.run "$(jq -nc --arg sha "$sha" --arg node "$node_version" --arg b "$1" --argjson t "${2:-600}" \
    '{slug: "ex-express", sha: $sha, nodeVersion: $node, packageManager: "yarn", rootDir: "express", buildCommand: $b, timeoutSec: $t}')"
}
expect "a build can't write /etc" "$(build_cmd 'touch /etc/layer-pwned')" '.error.code == "build_failed"'
[[ ! -e /etc/layer-pwned ]] && pass "  (and /etc/layer-pwned doesn't exist)" || { fail "/etc/layer-pwned exists"; rm -f /etc/layer-pwned; }
expect "a build can't read /etc/shadow" "$(build_cmd 'cat /etc/shadow')" '.error.code == "build_failed"'
expect "a build can't read another app's folder" "$(build_cmd 'ls /srv/apps/ex-next')" '.error.code == "build_failed"'
expect "a build runs as its own user" "$(build_cmd 'test "$(id -un)" = app-ex-express')" '.ok'
call env.write '{"slug":"ex-express","vars":{"NEXT_PUBLIC_GREETING":"hello from env"}}' >/dev/null
expect "the app's env vars reach the build" "$(build_cmd 'echo "greeting=$NEXT_PUBLIC_GREETING"')" '.ok'
log_has "  (log shows greeting=hello from env)" "greeting=hello from env"
expect "% and \$ in commands survive systemd untouched" "$(build_cmd 'echo "pct=100% home=$HOME"')" '.ok'
log_has "  (log shows pct=100% and the expanded \$HOME)" "pct=100% home=/srv/apps/ex-express/cache/home"

echo "Timeout and cancel"
t=$SECONDS
expect "a build over its time limit fails with timeout" "$(build_cmd 'sleep 300' 30)" '.error.code == "timeout"'
((SECONDS - t < 60)) && pass "  (stopped after ~30s, not 300s)" || fail "timeout took $((SECONDS - t))s"
(build_cmd 'sleep 300' >"$work/cancel.result") &
bg=$!
sleep 8
expect "build.cancel stops a running build" "$(call build.cancel '{"slug":"ex-express"}')" '.ok and .result.cancelled'
wait "$bg"
expect "  and that build reports cancelled" "$(cat "$work/cancel.result")" '.error.code == "cancelled"'

echo "Prune and cache"
releases=/srv/apps/ex-next/releases
for fake in 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222; do
  runuser -u app-ex-next -- mkdir -p "$releases/$fake"
  runuser -u app-ex-next -- touch -d "2 days ago" "$releases/$fake"
done
runuser -u app-ex-next -- mkdir -p "$releases/3333333333333333333333333333333333333333.partial"
expect "release.prune removes old releases and leftovers, keeps the live one" "$(call release.prune '{"slug":"ex-next","keep":1}')" \
  '.ok and (.result.removed | length) == 3'
[[ -d "$releases/$sha" && ! -e "$releases/1111111111111111111111111111111111111111" ]] && pass "  (live release kept, old ones gone)" || fail "prune result on disk"
res="$(call cache.clean '{"slug":"ex-next","maxMb":0}')"
expect "cache.clean empties package caches ($(jq -r '"\(.result.beforeMb)MB → \(.result.afterMb)MB"' <<<"$res"))" "$res" '.ok and .result.afterMb < .result.beforeMb'

echo "Cleanup"
for ex in "${examples[@]}"; do call app.delete "{\"slug\":\"ex-$ex\",\"keepData\":false}" >/dev/null; done
pass "removed the ex-* apps"

rm -rf "$work"
echo
if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "All build checks passed"

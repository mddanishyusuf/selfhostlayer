#!/usr/bin/env bash
# End-to-end test of a running layer-agent through its real unix socket, with
# socat as the client. Run as root on a box where install.sh and the agent are
# installed. It creates and deletes apps named e2e-*.
#   sudo bash installer/test/agent-e2e.sh
set -uo pipefail

sock=/run/layer/agent.sock
failures=0
n=0

command -v socat >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q socat >/dev/null
command -v jq >/dev/null || { echo "jq is required"; exit 1; }

pass() { printf '  \e[32m✓\e[0m %s\n' "$1"; }
fail() {
  printf '  \e[31m✗\e[0m %s\n' "$1"
  [[ -n "${2:-}" ]] && printf '      %s\n' "$2"
  failures=$((failures + 1))
}

# req <user> <json>: one request, prints the response line.
req() {
  local user="$1" json="$2"
  if [[ "$user" == root ]]; then
    printf '%s' "$json" | socat -t 600 - "UNIX-CONNECT:$sock" 2>&1
  else
    printf '%s' "$json" | runuser -u "$user" -- socat -t 600 - "UNIX-CONNECT:$sock" 2>&1
  fi
}

# call <action> <params-json>: as the panel user (layer).
call() {
  local params="${2:-}"
  [[ -n "$params" ]] || params='{}'
  n=$((n + 1))
  req layer "$(jq -nc --arg id "e2e$n" --arg a "$1" --argjson p "$params" '{id: $id, action: $a, params: $p}')"
}

# expect <name> <response> <jq filter that must be true>
expect() {
  if jq -e "$3" >/dev/null 2>&1 <<<"$2"; then pass "$1"; else fail "$1" "$2"; fi
}

cleanup() {
  for slug in e2e-one e2e-two; do
    call app.delete "{\"slug\":\"$slug\",\"keepData\":false}" >/dev/null
  done
}

echo "Socket access"
expect "socket is 660 root:layer" "\"$(stat -c '%a %U:%G' "$sock")\"" '. == "660 root:layer"'
out="$(req nobody '{"id":"x","action":"system.info"}')"
if grep -qi "permission denied" <<<"$out"; then pass "nobody is refused"; else fail "nobody is refused" "$out"; fi
out="$(req layer '{"id":"x","action":"system.info"}')"
expect "layer (the panel user) can connect" "$out" '.ok == true'

echo "Protocol"
expect "invalid JSON → bad_request" "$(req layer '{nope')" '.error.code == "bad_request"'
expect "unknown action → unknown_action" "$(call shell.exec)" '.error.code == "unknown_action"'
expect "bad slug → invalid_params" "$(call app.create '{"slug":"../etc"}')" '.error.code == "invalid_params"'

echo "system.info"
out="$(call system.info)"
expect "reports OS, memory, disk, Node versions, Caddy" "$out" \
  '.result.os.id != "" and .result.memoryMb.total > 0 and .result.diskGb.free > 0 and (.result.nodeVersions | length) > 0 and .result.caddy == "active"'

cleanup
echo "app.create"
out="$(call app.create '{"slug":"e2e-one"}')"
expect "creates e2e-one" "$out" '.ok and .result.created and .result.user == "app-e2e-one"'
blue="$(jq -r .result.ports.blue <<<"$out")"
green="$(jq -r .result.ports.green <<<"$out")"
expect "user has no login shell" "\"$(getent passwd app-e2e-one | cut -d: -f7)\"" '. == "/usr/sbin/nologin"'
expect "user is in layer-apps" "\"$(id -nG app-e2e-one)\"" 'contains("layer-apps")'
expect "/srv/apps/e2e-one is 750 app-e2e-one" "\"$(stat -c '%a %U' /srv/apps/e2e-one)\"" '. == "750 app-e2e-one"'
expect "data/ is 700" "\"$(stat -c '%a' /srv/apps/e2e-one/data)\"" '. == "700"'
expect "app.env is 600 root" "\"$(stat -c '%a %U' /etc/layer/apps/e2e-one/app.env)\"" '. == "600 root"'
if grep -qx "PORT=$blue" /etc/layer/apps/e2e-one/blue.env; then pass "blue.env has its port"; else fail "blue.env has its port"; fi
expect "repeat create is a no-op with the same ports" "$(call app.create '{"slug":"e2e-one"}')" \
  ".result.created == false and .result.ports.blue == $blue and .result.ports.green == $green"
out="$(call app.create '{"slug":"e2e-two"}')"
expect "second app gets different ports" "$out" \
  "[.result.ports.blue, .result.ports.green] | (index($blue) == null and index($green) == null)"
if runuser -u app-e2e-one -- ls /srv/apps/e2e-two >/dev/null 2>&1; then
  fail "app-e2e-one can't read e2e-two's folder"
else
  pass "app-e2e-one can't read e2e-two's folder"
fi
if runuser -u app-e2e-one -- ls /srv/apps >/dev/null 2>&1; then
  fail "app users can't list /srv/apps"
else
  pass "app users can't list /srv/apps"
fi

echo "env.write"
# Deliberately literal: $, backticks and quotes must survive unexpanded.
# shellcheck disable=SC2016
tricky='a "quoted" $HOME ${PATH} `id` 100% back\slash #hash  '\''single'\'' é✓ trailing  '
params="$(jq -nc --arg v "$tricky" '{slug: "e2e-one", vars: {TRICKY: $v, SECRET_TOKEN: "s3cr3t-e2e-value", EMPTY: ""}}')"
expect "writes vars and returns only keys" "$(call env.write "$params")" \
  '.ok and (.result.keys | sort) == ["EMPTY", "SECRET_TOKEN", "TRICKY"] and (tostring | contains("s3cr3t") | not)'
got="$(systemd-run --quiet --wait --pipe -p EnvironmentFile=/etc/layer/apps/e2e-one/app.env /usr/bin/env | grep '^TRICKY=')"
if [[ "$got" == "TRICKY=$tricky" ]]; then pass "systemd reads tricky values back exactly"; else fail "systemd reads tricky values back exactly" "$got"; fi
expect "rejects a newline in a value" \
  "$(call env.write '{"slug":"e2e-one","vars":{"A":"x\nPORT=1"}}')" '.error.code == "invalid_params"'
expect "rejects unknown apps" "$(call env.write '{"slug":"e2e-ghost","vars":{}}')" '.error.code == "not_found"'

echo "node.install"
installed="$(jq -r '.result.nodeVersions[0]' <<<"$(call system.info)")"
expect "existing version is a no-op" "$(call node.install "{\"version\":\"$installed\"}")" '.result.installed == false'
expect "rejects non-exact versions" "$(call node.install '{"version":"latest"}')" '.error.code == "invalid_params"'
expect "unknown version → not_found" "$(call node.install '{"version":"24.99.0"}')" '.error.code == "not_found"'
v22="$(curl -fsS https://nodejs.org/dist/index.json | jq -r '[.[] | select(.version | startswith("v22."))][0].version | ltrimstr("v")')"
if [[ ! -x "/opt/layer/node/$v22/bin/node" ]]; then
  expect "downloads, verifies and installs Node $v22" "$(call node.install "{\"version\":\"$v22\"}")" '.result.installed == true'
fi
expect "Node $v22 runs" "\"$("/opt/layer/node/$v22/bin/node" -v 2>&1)\"" ". == \"v$v22\""
expect "runtime is root-owned, not group/world-writable" \
  "\"$(stat -c '%U' "/opt/layer/node/$v22")$(find "/opt/layer/node/$v22" -type f -perm /022 | wc -l)\"" '. == "root0"'

echo "app.delete"
echo "rows" >/srv/apps/e2e-one/data/db.sqlite
out="$(call app.delete '{"slug":"e2e-one"}')"
expect "deletes e2e-one and archives data" "$out" '.ok and .result.archivedData != null'
archive="$(jq -r .result.archivedData <<<"$out")"
expect "archived data is intact" "\"$(cat "$archive/db.sqlite" 2>&1)\"" '. == "rows"'
if id app-e2e-one >/dev/null 2>&1; then fail "user app-e2e-one is gone"; else pass "user app-e2e-one is gone"; fi
if [[ -e /srv/apps/e2e-one || -e /etc/layer/apps/e2e-one ]]; then fail "folders are gone"; else pass "folders are gone"; fi
expect "deleting again → not_found" "$(call app.delete '{"slug":"e2e-one"}')" '.error.code == "not_found"'
rm -rf "$archive"

echo "Audit log"
log=/var/log/layer/audit.jsonl
expect "audit log is 600 root" "\"$(stat -c '%a %U' "$log")\"" '. == "600 root"'
if grep -q '"action":"app.create","phase":"start"' "$log"; then pass "records app.create"; else fail "records app.create"; fi
if grep -q "s3cr3t-e2e-value" "$log"; then fail "never contains env values"; else pass "never contains env values"; fi

cleanup
echo
if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "All agent checks passed"

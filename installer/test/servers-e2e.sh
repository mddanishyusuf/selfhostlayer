#!/usr/bin/env bash
# Servers, Day 1: this server's panel reaching another server's agent over the
# link (PLAN-SERVERS.md). Run as root on the panel's server, after the other
# one ran install.sh --agent-only --panel-key <this panel's key>:
#   sudo bash installer/test/servers-e2e.sh <other server's IP>
# SC2015: `[[ check ]] && pass || fail` is intended (pass never fails).
# shellcheck disable=SC2015
set -uo pipefail
other="${1:?the IP of the other server}"
key=/var/lib/layer/ssh/id_ed25519
failures=0
pass() { printf '  \e[32m✓\e[0m %s\n' "$1"; }
fail() {
  printf '  \e[31m✗\e[0m %s\n' "$1"
  [[ -n "${2:-}" ]] && printf '%s\n' "$2" | head -10 | sed 's/^/      /'
  failures=$((failures + 1))
}
# ssh as the panel does: its key, its known_hosts, nothing else.
link() { runuser -u layer -- ssh -F /dev/null -T -i "$key" -o BatchMode=yes -o IdentitiesOnly=yes -o UserKnownHostsFile=/var/lib/layer/ssh/known_hosts-test -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "$@"; }

echo "The panel's key"
[[ -f "$key" ]] || runuser -u layer -- bash -c "mkdir -p -m 700 /var/lib/layer/ssh && ssh-keygen -q -t ed25519 -N '' -C layer-panel -f $key"
[[ "$(stat -c '%U %a' "$key")" == "layer 600" ]] && pass "the panel's private key is the panel's alone" || fail "key: $(stat -c '%U %a' "$key")"

echo "A call over the link"
out="$(printf '{"id":"e2e1","action":"system.info","params":{}}\n' | link "layer-link@$other" | head -1)"
jq -e '.ok == true and .result.agentOnly == true' <<<"$out" >/dev/null && pass "system.info from the other server's agent (agent-only)" || fail "system.info over the link" "$out"
ip="$(jq -r '.result.publicIp' <<<"$out")"
pass "it says its address is $ip, its free addresses <app>.$(jq -r '.result.appsDomain' <<<"$out")"

echo "Nothing else over that key"
out="$(link "layer-link@$other" id </dev/null 2>&1 | head -3)"
grep -q "uid=" <<<"$out" && fail "the key ran a command" "$out" || pass "a command is ignored: the key only reaches the agent"
out="$(timeout 15 runuser -u layer -- ssh -F /dev/null -tt -i "$key" -o BatchMode=yes -o UserKnownHostsFile=/var/lib/layer/ssh/known_hosts-test "layer-link@$other" </dev/null 2>&1 | head -3)"
grep -qE '\$ |# |uid=' <<<"$out" && fail "a terminal opened" "$out" || pass "no terminal"
out="$(link -W 127.0.0.1:22 "layer-link@$other" </dev/null 2>&1 | head -3)"
grep -q "SSH-2.0" <<<"$out" && fail "stdio forwarding works" "$out" || pass "no forwarding (stdio)"
link -N -o ExitOnForwardFailure=yes -L 127.0.0.1:2299:127.0.0.1:22 "layer-link@$other" </dev/null >/dev/null 2>&1 &
sleep 3
timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/2299 && head -c 20 <&3' 2>/dev/null | grep -q SSH && fail "port forwarding works" || pass "no forwarding (ports)"
kill %1 2>/dev/null

echo "The other server keeps its own record"
out="$(printf '{"id":"e2e2","action":"audit.tail","params":{"limit":20}}\n' | link "layer-link@$other" | head -1)"
jq -e '.ok == true' <<<"$out" >/dev/null && pass "its agent answers audit.tail over the link" || fail "audit.tail" "$out"

echo "Backups over the link: a snapshot there, fetched here; a file put there, restored"
call() { printf '%s\n' "$(jq -nc --arg a "$1" --argjson p "$2" '{id: "e2e", action: $a, params: $p}')" | link "layer-link@$other"; }
# put <file name> <offset> <local piece>: the data from a file (an argument is capped at 128 KB).
put() { base64 -w0 "$3" >"$3.b64"; jq -nc --arg f "$1" --argjson o "$2" --rawfile d "$3.b64" '{id: "e2e", action: "backup.put", params: {file: $f, offset: $o, data: $d}}' | link "layer-link@$other"; }
call app.delete '{"slug":"linktest","keepData":false}' >/dev/null
call app.create '{"slug":"linktest"}' | tail -1 | jq -e .ok >/dev/null && pass "an app there"
work="$(mktemp -d)"
snap="$(call backup.snapshot '{"slug":"linktest"}' | tail -1)"
file="$(jq -r .result.file <<<"$snap")"
[[ "$file" == linktest-* ]] && pass "a snapshot there ($file)" || fail "snapshot" "$snap"
call backup.fetch "{\"file\":\"$file\"}" | jq -r 'select(.chunk) | .chunk' | base64 -d >"$work/$file"
there="$(call backup.fetch "{\"file\":\"$file\"}" | tail -1 | jq -r .result.bytes)"
[[ "$(stat -c %s "$work/$file")" == "$there" ]] && tar -tzf "$work/$file" >/dev/null 2>&1 && pass "fetched here whole ($there bytes, a good tar.gz)" || fail "fetch: $(stat -c %s "$work/$file") of $there bytes"
put="linktest-$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 4).tar.gz"
size="$(stat -c %s "$work/$file")"
split -b 400000 "$work/$file" "$work/piece-"
rm -f "$work"/piece-*.b64
offset=0
for piece in "$work"/piece-*; do
  r="$(put "$put" "$offset" "$piece" | tail -1)"
  jq -e .ok <<<"$r" >/dev/null || { fail "backup.put at $offset" "$r"; break; }
  offset=$((offset + $(stat -c %s "$piece")))
done
[[ "$offset" == "$size" ]] && pass "put there in pieces ($size bytes)" || fail "put $offset of $size"
r="$(call backup.put "{\"file\":\"$put\",\"offset\":0,\"data\":\"eA==\"}" | tail -1)"
jq -e '.ok == false' <<<"$r" >/dev/null && pass "a put never writes over a file already there" || fail "overwrote" "$r"
r="$(call backup.restore "{\"slug\":\"linktest\",\"file\":\"$put\"}" | tail -1)"
jq -e .ok <<<"$r" >/dev/null && pass "restored there from the file put over the link" || fail "restore" "$r"
echo "A bigger file both ways (pieces and chunks)"
mkdir -p "$work/big"
head -c 1200000 /dev/urandom >"$work/big/big.bin"
sum="$(sha256sum <"$work/big/big.bin" | cut -d' ' -f1)"
tar -czf "$work/big.tar.gz" -C "$work/big" .
put2="linktest-$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 4).tar.gz"
rm -f "$work"/piece-*
split -b 500000 "$work/big.tar.gz" "$work/piece-"
offset=0
for piece in "$work"/piece-*; do
  put "$put2" "$offset" "$piece" | tail -1 | jq -e .ok >/dev/null || fail "put at $offset"
  offset=$((offset + $(stat -c %s "$piece")))
done
call backup.restore "{\"slug\":\"linktest\",\"file\":\"$put2\"}" | tail -1 | jq -e .ok >/dev/null && pass "1.2 MB put there in $(ls "$work"/piece-?? | wc -l) pieces and restored" || fail "big restore"
snap2="$(call backup.snapshot '{"slug":"linktest"}' | tail -1 | jq -r .result.file)"
call backup.fetch "{\"file\":\"$snap2\"}" | jq -r 'select(.chunk) | .chunk' | base64 -d >"$work/back.tar.gz"
mkdir -p "$work/back" && tar -xzf "$work/back.tar.gz" -C "$work/back"
[[ "$(sha256sum <"$work/back/big.bin" | cut -d' ' -f1)" == "$sum" ]] && pass "and fetched back in chunks, the same bytes" || fail "big.bin differs after the round trip"
call backup.discard "{\"file\":\"$snap2\"}" >/dev/null
call backup.discard "{\"file\":\"$file\"}" >/dev/null
call app.delete '{"slug":"linktest","keepData":false}' >/dev/null
rm -rf "$work"

if ((failures)); then echo "$failures check(s) failed"; exit 1; fi
echo "All server checks passed"

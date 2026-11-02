#!/usr/bin/env bash
# Sites, Day 1: PHP for a site, end to end through the agent and Caddy.
# Two PHP sites side by side; each answers, and neither can reach the other.
# Run as root after install.sh:  sudo bash installer/test/php-e2e.sh
# SC2015: `[[ check ]] && pass || fail` is intended (pass never fails).
# shellcheck disable=SC2015
set -uo pipefail
sock=/run/layer/agent.sock
failures=0
command -v socat >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q socat >/dev/null
pass() { printf '  \e[32m✓\e[0m %s\n' "$1"; }
fail() {
  printf '  \e[31m✗\e[0m %s\n' "$1"
  [[ -n "${2:-}" ]] && printf '%s\n' "$2" | head -20 | sed 's/^/      /'
  failures=$((failures + 1))
}
call() {
  jq -nc --arg id "c$RANDOM" --arg a "$1" --argjson p "${2:-{\}}" '{id: $id, action: $a, params: $p}' |
    runuser -u layer -- socat -t 900 - "UNIX-CONNECT:$sock" | grep -av '"chunk"' | tail -1
}
expect() { if jq -e "$3" >/dev/null 2>&1 <<<"$2"; then pass "$1"; else fail "$1" "$2"; fi; }
get() { curl -sk --max-time 10 --resolve "$1.internal:443:127.0.0.1" "https://$1.internal$2"; }
code() { curl -sk --max-time 10 -o /dev/null -w '%{http_code}' --resolve "$1.internal:443:127.0.0.1" "https://$1.internal$2"; }
# as <slug> <cmd…>: run as the site's user.
as() { local s="$1"; shift; runuser -u "app-$s" -- "$@"; }

for s in phpa phpb; do call app.delete "{\"slug\":\"$s\",\"keepData\":false}" >/dev/null; done

echo "PHP, installed once"
out="$(call service.install '{"name":"php"}')"
expect "service.install php" "$out" '.ok == true and (.result.version | test("^8\\."))'
version="$(jq -r .result.version <<<"$out")"
systemctl is-enabled --quiet "php$version-fpm" && fail "the distro's shared php-fpm is still enabled" || pass "the distro's shared php-fpm stays off"
out="$(call service.install '{"name":"php"}')"
expect "a second install is a no-op" "$out" '.ok == true and .result.already == true'

echo "Two sites"
for s in phpa phpb; do
  call app.create "{\"slug\":\"$s\"}" >/dev/null
  as "$s" mkdir -p "/srv/apps/$s/data/site/uploads"
  as "$s" tee "/srv/apps/$s/data/site/index.php" >/dev/null <<PHP
<?php
\$other = '$s' === 'phpa' ? 'phpb' : 'phpa';
header('Content-Type: text/plain');
echo "hello from $s\n";
echo 'user=' . posix_getpwuid(posix_geteuid())['name'] . "\n";
echo 'other=' . var_export(@file_get_contents("/srv/apps/\$other/data/site/secret-config.php"), true) . "\n";
echo 'passwd=' . var_export(@file_get_contents('/etc/passwd'), true) . "\n";
echo 'exec=' . (function_exists('shell_exec') && is_callable('shell_exec') ? @shell_exec('id') : 'disabled') . "\n";
\$f = __DIR__ . '/uploads/written.txt';
echo 'write=' . var_export(@file_put_contents(\$f, 'x'), true) . "\n";
echo 'tmp=' . var_export(@file_put_contents('/tmp/t', 'x'), true) . "\n";
PHP
  as "$s" tee "/srv/apps/$s/data/site/secret-config.php" >/dev/null <<<"<?php // the $s secret"
  as "$s" tee "/srv/apps/$s/data/site/uploads/evil.php" >/dev/null <<<'<?php echo "RAN";'
  as "$s" tee "/srv/apps/$s/data/site/.env" >/dev/null <<<"SECRET=1"
  as "$s" tee "/srv/apps/$s/data/site/style.css" >/dev/null <<<"body{}"
  out="$(call php.write "{\"slug\":\"$s\",\"root\":\"site\",\"private\":[\"secret-config.php\"],\"memoryMaxMb\":256}")"
  expect "php.write $s" "$out" '.ok == true'
  out="$(call proxy.set "{\"slug\":\"$s\",\"php\":true,\"domains\":[\"$s.internal\"],\"block\":[\"/uploads/*.php\",\"/secret-config.php\"]}")"
  expect "proxy.set $s (php)" "$out" '.ok == true and .result.php == true'
done
sleep 2

echo "Each answers, as its own user, and only inside itself"
for s in phpa phpb; do
  body="$(get "$s" /)"
  grep -q "hello from $s" <<<"$body" && pass "$s answers through Caddy" || fail "$s didn't answer" "$body"
  grep -q "user=app-$s" <<<"$body" && pass "$s's PHP runs as app-$s" || fail "$s's PHP user" "$body"
  grep -q "other=false" <<<"$body" && pass "$s can't read the other site's files (open_basedir)" || fail "$s read the other site" "$body"
  grep -q "passwd=false" <<<"$body" && pass "$s can't read /etc/passwd" || fail "$s read /etc/passwd" "$body"
  grep -q "exec=disabled" <<<"$body" && pass "$s can't run shell commands" || fail "$s ran a command" "$body"
  grep -q "write=1" <<<"$body" && pass "$s can write in its own folder" || fail "$s can't write its folder" "$body"
  grep -q "tmp=1" <<<"$body" && pass "$s has its own /tmp" || fail "$s can't write /tmp" "$body"
  [[ "$(get "$s" /style.css)" == "body{}" ]] && pass "Caddy serves $s's static files" || fail "static file" "$(get "$s" /style.css)"
  [[ "$(get "$s" /uploads/written.txt)" == "x" ]] && pass "and the files PHP wrote later (default ACL)" || fail "a file PHP wrote isn't served" "$(getfacl "/srv/apps/$s/data/site/uploads/written.txt" 2>&1)"
  [[ "$(code "$s" /uploads/evil.php)" == 404 ]] && pass "PHP in uploads isn't run" || fail "uploads/evil.php: $(get "$s" /uploads/evil.php)"
  [[ "$(code "$s" /.env)" == 404 ]] && pass "dotfiles aren't served" || fail ".env: $(code "$s" /.env)"
  [[ "$(code "$s" /secret-config.php)" == 404 ]] && pass "blocked paths aren't served" || fail "secret-config.php: $(code "$s" /secret-config.php)"
  getfacl -p "/srv/apps/$s/data/site/secret-config.php" 2>/dev/null | grep -q '^user:caddy' && fail "Caddy has an ACL on the private file" || pass "Caddy has no access to the private file"
done
sock_a=/run/layer-php/phpa/php.sock
runuser -u app-phpb -- test -w "$sock_a" 2>/dev/null && fail "phpb can reach phpa's PHP socket" || pass "one site can't reach the other's PHP socket"
runuser -u nobody -- ls /run/layer-php/phpa >/dev/null 2>&1 && fail "anyone can list a site's socket folder" || pass "only Caddy and the site get to the socket"

echo "Idle cost, the sandbox"
pids="$(systemctl show -p MainPID --value app-phpa-php.service)"
workers="$(pgrep -c -P "$pids" || true)"
sleep 35
workers_idle="$(pgrep -c -P "$pids" || true)"
[[ "$workers_idle" == 0 ]] && pass "no workers when idle (ondemand; $workers after requests)" || fail "workers left after 35s idle: $workers_idle"
rss="$(ps -o rss= -p "$pids" | tr -d ' ')"
pass "an idle site's PHP: $((rss / 1024)) MB RSS"
score="$(systemd-analyze security app-phpa-php.service 2>/dev/null | tail -1)"
pass "sandbox: $score"

echo "Restore puts Caddy's access back"
chmod 700 /srv/apps/phpa/data
out="$(call php.write '{"slug":"phpa","root":"site","private":["secret-config.php"],"memoryMaxMb":256}')"
[[ "$(get phpa /style.css)" == "body{}" ]] && pass "php.write repairs Caddy's access" || fail "access not repaired"

echo "Delete"
for s in phpa phpb; do
  out="$(call app.delete "{\"slug\":\"$s\",\"keepData\":false}")"
  expect "app.delete $s" "$out" '.ok == true'
done
[[ ! -e /etc/systemd/system/app-phpa-php.service && ! -e /run/layer-php/phpa/php.sock ]] && pass "its PHP unit and socket are gone" || fail "PHP leftovers" "$(ls /etc/systemd/system/app-php* /run/layer-php 2>&1)"

if ((failures)); then echo "$failures check(s) failed"; exit 1; fi
echo "All PHP checks passed"

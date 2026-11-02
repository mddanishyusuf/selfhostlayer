#!/usr/bin/env bash
# Sites, Day 3: MySQL 8 and a Ghost site, end to end through the agent and
# Caddy, the way the panel drives it. Run as root after install.sh:
#   sudo bash installer/test/ghost-e2e.sh
# Needs the internet (cdn.mysql.com, the npm registry). The first run
# downloads MySQL 8 (80 MB on x86_64, 800 MB on aarch64).
# SC2015: `[[ check ]] && pass || fail` is intended (pass never fails).
# shellcheck disable=SC2015
set -uo pipefail
sock=/run/layer/agent.sock
slug=ghosttest
other=ghostother
host=$slug.internal
node_version=24.22.2
staging=/var/lib/layer-staging
restore_dir=/var/lib/layer/restore
work="$(mktemp -d)"
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
    runuser -u layer -- socat -t 3600 - "UNIX-CONNECT:$sock" | grep -av '"chunk"' | tail -1
}
expect() { if jq -e "$3" >/dev/null 2>&1 <<<"$2"; then pass "$1"; else fail "$1" "$2"; fi; }
curl_() { curl -sk --max-time 30 --resolve "$host:443:127.0.0.1" "$@"; }
code() { curl_ -o /dev/null -w '%{http_code}' "https://$host$1"; }
admin() { curl_ -b "$work/jar" -c "$work/jar" -H "Origin: https://$host" "$@"; }

for s in "$slug" "$other"; do call app.delete "{\"slug\":\"$s\",\"keepData\":false}" >/dev/null; done

echo "MySQL 8, installed once (Oracle's tarball, checked against its signature)"
out="$(call service.install '{"name":"mysql8"}')"
expect "service.install mysql8" "$out" '.ok == true and (.result.version | test("^8\\.4"))'
systemctl is-active --quiet layer-mysql8 && pass "layer-mysql8 runs" || fail "layer-mysql8 isn't running" "$(journalctl -u layer-mysql8 -n 10 --no-pager)"
ss -ltn | grep -q '127.0.0.1:3307 ' && pass "it listens on 127.0.0.1:3307 only" || fail "not on 127.0.0.1:3307" "$(ss -ltn | grep 3307)"
ss -ltn | grep -qE '0.0.0.0:3307|\*:3307|\[::\]:3307' && fail "it listens publicly" || pass "nothing public"
[[ "$(stat -c '%U %a' /var/lib/layer-agent/mysql8-admin.json)" == "root 600" ]] && pass "root's password is root's alone" || fail "admin file: $(stat -c '%U %a' /var/lib/layer-agent/mysql8-admin.json)"
LD_LIBRARY_PATH=/opt/layer/mysql/8.4.13/lib/compat /opt/layer/mysql/8.4.13/bin/mysql --protocol=TCP -h127.0.0.1 -P3307 -uroot -e 'SELECT 1' >/dev/null 2>&1 && fail "root logs in without a password" || pass "root needs its password"
expect "a second install is a no-op" "$(call service.install '{"name":"mysql8"}')" '.ok == true and .result.already == true'

echo "Two sites' databases, apart"
for s in "$slug" "$other"; do
  call app.create "{\"slug\":\"$s\"}" >/dev/null
  expect "mysql8.add $s" "$(call mysql8.add "{\"slug\":\"$s\"}")" '.ok == true'
done
pw_other="$(jq -r .mysql8.password "/etc/layer/apps/$other/services.json")"
LD_LIBRARY_PATH=/opt/layer/mysql/8.4.13/lib/compat MYSQL_PWD="$pw_other" /opt/layer/mysql/8.4.13/bin/mysql --protocol=TCP -h127.0.0.1 -P3307 -uapp_ghostother -e 'USE app_ghosttest' >/dev/null 2>&1 && fail "one site can open the other's database" || pass "one site can't open the other's database"
call app.delete "{\"slug\":\"$other\",\"keepData\":false}" >/dev/null

echo "Ghost, the way the panel deploys it"
expect "env (its address)" "$(call env.write "{\"slug\":\"$slug\",\"vars\":{\"GHOST_URL\":\"https://$host\",\"GHOST_MAIL__TRANSPORT\":\"SMTP\",\"GHOST_MAIL__OPTIONS__HOST\":\"127.0.0.1\",\"GHOST_MAIL__OPTIONS__PORT\":\"25\",\"GHOST_MAIL__FROM\":\"noreply@$host\"}}")" '.ok == true'
expect "Node $node_version" "$(call node.install "{\"version\":\"$node_version\"}")" '.ok == true'
out="$(call ghost.fetch "{\"slug\":\"$slug\"}")"
expect "ghost.fetch (checked against the registry's integrity)" "$out" '.ok == true and (.result.release | test("^[0-9a-f]{40}$"))'
release="$(jq -r .result.release <<<"$out")"
version="$(jq -r .result.version <<<"$out")"
[[ -d "/srv/apps/$slug/data/content/themes/casper" ]] && pass "Ghost's starting content is in data/content" || fail "no data/content/themes/casper"
out="$(call build.run "{\"slug\":\"$slug\",\"sha\":\"$release\",\"nodeVersion\":\"$node_version\",\"packageManager\":\"pnpm\",\"installCommand\":\"pnpm install --prod --frozen-lockfile\",\"memoryMb\":2048,\"timeoutSec\":2400}")"
expect "its dependencies installed, as the site (pnpm --prod)" "$out" '.ok == true'
expect "unit.write" "$(call unit.write "{\"slug\":\"$slug\",\"nodeVersion\":\"$node_version\",\"exec\":[\"node\",\"layer-ghost.js\"],\"memoryMaxMb\":768}")" '.ok == true'
expect "release.point" "$(call release.point "{\"slug\":\"$slug\",\"color\":\"blue\",\"sha\":\"$release\"}")" '.ok == true'
out="$(call unit.start "{\"slug\":\"$slug\",\"color\":\"blue\",\"healthPath\":\"/ghost/api/admin/site/\",\"timeoutSec\":180}")"
expect "Ghost $version starts and answers (it migrates its database on the first start)" "$out" '.ok == true'

echo "The owner, made before it's public"
out="$(call ghost.setup "$(jq -nc --arg s "$slug" --arg u "https://$host" '{slug: $s, color: "blue", url: $u, title: "Test Ghost", name: "Owner", email: "owner@example.com"}')")"
expect "ghost.setup" "$out" '.ok == true and (.result.password | length) >= 10'
password="$(jq -r .result.password <<<"$out")"
expect "a second setup is refused" "$(call ghost.setup "$(jq -nc --arg s "$slug" --arg u "https://$host" '{slug: $s, color: "blue", url: $u, title: "X", name: "X", email: "x@example.com"}')")" '.ok == false'
expect "proxy.set" "$(call proxy.set "{\"slug\":\"$slug\",\"color\":\"blue\",\"domains\":[\"$host\"]}")" '.ok == true'
sleep 2
grep -q "Test Ghost" <<<"$(curl_ "https://$host/")" && pass "the home page (Casper)" || fail "home page" "$(curl_ "https://$host/" | head -c 300)"

echo "Writing, as the owner"
admin -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d "$(jq -nc --arg p "$password" '{username: "owner@example.com", password: $p}')" "https://$host/ghost/api/admin/session/" | grep -q 201 && pass "the owner signs in" || fail "sign-in failed"
out="$(admin -H 'Content-Type: application/json' -d '{"posts":[{"title":"Hello from the e2e","html":"<p>Body</p>","status":"published"}]}' "https://$host/ghost/api/admin/posts/?source=html")"
post_url="$(jq -r '.posts[0].url' <<<"$out" 2>/dev/null)"
[[ "$post_url" == https://$host/* ]] && pass "a post is published" || fail "post not published" "$out"
grep -q "Hello from the e2e" <<<"$(curl_ "$post_url")" && pass "and served" || fail "post not served"
php -r '$i = imagecreatetruecolor(20, 20); imagepng($i, "/tmp/ghost-e2e.png");' 2>/dev/null || printf '\x89PNG\r\n\x1a\n' >/tmp/ghost-e2e.png
img="$(admin -F "file=@/tmp/ghost-e2e.png;type=image/png" -F "ref=e2e" "https://$host/ghost/api/admin/images/upload/" | jq -r '.images[0].url' 2>/dev/null)"
[[ "$(code "${img#https://$host}")" == 200 ]] && pass "an uploaded image is served ($img)" || fail "image: $img"
ls "/srv/apps/$slug/data/content/images" >/dev/null 2>&1 && pass "images land in data/content" || fail "no data/content/images"

echo "Email out of the box (the server's own Postfix)"
since="$(date '+%Y-%m-%d %H:%M:%S')"
role="$(admin "https://$host/ghost/api/admin/roles/?permissions=assign" | jq -r '.roles[] | select(.name=="Author") | .id' 2>/dev/null)"
code="$(admin -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d "{\"invites\":[{\"email\":\"invitee@example.invalid\",\"role_id\":\"$role\"}]}" "https://$host/ghost/api/admin/invites/")"
[[ "$code" == 201 ]] && pass "Ghost sent an invite email (the API answered 201)" || fail "invite: HTTP $code"
sleep 2
journalctl --since "$since" -o cat --no-pager | grep -qi "from=<noreply@$host>" && pass "Postfix took it, from noreply@$host" || fail "not in Postfix's log" "$(journalctl --since "$since" -o cat --no-pager | grep -i postfix | tail -5)"

echo "Back up and restore (with the MySQL 8 dump)"
out="$(call backup.snapshot "{\"slug\":\"$slug\"}")"
expect "snapshot" "$out" '.ok == true and .result.mysql8.bytes > 0'
file="$(jq -r .result.file <<<"$out")"
id="$(admin "https://$host/ghost/api/admin/posts/?filter=title:'Hello%20from%20the%20e2e'" | jq -r '.posts[0].id')"
admin -X DELETE -o /dev/null "https://$host/ghost/api/admin/posts/$id/"
[[ "$(code "${post_url#https://$host}")" == 404 ]] && pass "the post is gone" || fail "post still there"
install -d -o layer -g layer -m 700 "$restore_dir"
install -o layer -g layer -m 600 "$staging/$file" "$restore_dir/$file"
expect "restore" "$(call backup.restore "{\"slug\":\"$slug\",\"file\":\"$file\"}")" '.ok == true'
sleep 8
[[ "$(code "${post_url#https://$host}")" == 200 ]] && pass "the post is back" || fail "post not restored: $(code "${post_url#https://$host}")"
rm -f "$staging/$file" "$restore_dir/$file"

echo "Delete"
expect "app.delete" "$(call app.delete "{\"slug\":\"$slug\",\"keepData\":false}")" '.ok == true'
LD_LIBRARY_PATH=/opt/layer/mysql/8.4.13/lib/compat /opt/layer/mysql/8.4.13/bin/mysql --defaults-extra-file=<(printf '[client]\nuser=root\npassword="%s"\n' "$(jq -r .password /var/lib/layer-agent/mysql8-admin.json)") --socket=/run/layer-mysql8/mysqld.sock -N -e "SHOW DATABASES LIKE 'app_ghosttest'" | grep -q app_ghosttest && fail "its database is still there" || pass "its database and user are gone"

rm -rf "$work"
if ((failures)); then echo "$failures check(s) failed"; exit 1; fi
echo "All Ghost checks passed"

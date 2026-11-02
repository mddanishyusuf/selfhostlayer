#!/usr/bin/env bash
# Sites, Day 2: a WordPress site end to end through the agent and Caddy.
# Run as root after install.sh:  sudo bash installer/test/wordpress-e2e.sh
# Needs the internet (wordpress.org, a plugin from it).
# SC2015: `[[ check ]] && pass || fail` is intended (pass never fails).
# shellcheck disable=SC2015
set -uo pipefail
sock=/run/layer/agent.sock
slug=wptest
host=$slug.internal
docroot=/srv/apps/$slug/data/wordpress
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
    runuser -u layer -- socat -t 1200 - "UNIX-CONNECT:$sock" | grep -av '"chunk"' | tail -1
}
expect() { if jq -e "$3" >/dev/null 2>&1 <<<"$2"; then pass "$1"; else fail "$1" "$2"; fi; }
curl_() { curl -sk --max-time 20 --resolve "$host:443:127.0.0.1" "$@"; }
code() { curl_ -o /dev/null -w '%{http_code}' "https://$host$1"; }
# wp …: wp-cli as the site's user, as the agent runs it.
wp() { runuser -u "app-$slug" -- env HOME=/tmp php /opt/layer/tools/wp-cli/*/wp-cli.phar --path="$docroot" --no-color "$@"; }

call app.delete "{\"slug\":\"$slug\",\"keepData\":false}" >/dev/null

echo "What a WordPress site needs"
expect "PHP" "$(call service.install '{"name":"php"}')" '.ok == true'
expect "MariaDB" "$(call service.install '{"name":"mysql"}')" '.ok == true'
call app.create "{\"slug\":\"$slug\"}" >/dev/null
expect "its own database" "$(call mysql.add "{\"slug\":\"$slug\"}")" '.ok == true'
out="$(call wordpress.fetch '{}')"
expect "WordPress, checked against wordpress.org's sha1" "$out" '.ok == true and (.result.version | test("^[0-9]"))'
version="$(jq -r .result.version <<<"$out")"
[[ -f /opt/layer/tools/wp-cli/2.12.0/wp-cli.phar ]] && pass "wp-cli, the pinned phar" || fail "no wp-cli"

echo "Install, with the owner made at once"
out="$(call wordpress.install "$(jq -nc --arg s "$slug" --arg v "$version" --arg u "https://$host" '{slug: $s, version: $v, url: $u, title: "Test Blog", adminUser: "owner", adminEmail: "owner@example.com"}')")"
expect "wordpress.install" "$out" '.ok == true and (.result.adminPassword | length) >= 20'
password="$(jq -r .result.adminPassword <<<"$out")"
block="$(jq -c .result.block <<<"$out")"
expect "proxy.set" "$(call proxy.set "{\"slug\":\"$slug\",\"php\":true,\"domains\":[\"$host\"],\"block\":$block}")" '.ok == true'
sleep 1
grep -q "Test Blog" <<<"$(curl_ "https://$host/")" && pass "the home page" || fail "home page" "$(curl_ "https://$host/" | head -c 400)"
[[ "$(code /wp-admin/install.php)" != 200 ]] || curl_ "https://$host/wp-admin/install.php" | grep -qi "already installed" && pass "nobody else can run the installer" || fail "the installer is open"
for p in /wp-config.php /readme.html /xmlrpc.php /license.txt; do
  [[ "$(code "$p")" == 404 ]] && pass "$p isn't served" || fail "$p: $(code "$p")"
done
[[ "$(stat -c '%U %a' "$docroot/wp-config.php")" == "app-$slug 600" ]] && pass "wp-config.php is the site's alone (600)" || fail "wp-config.php: $(stat -c '%U %a' "$docroot/wp-config.php")"
grep -q "DISALLOW_FILE_EDIT', true" "$docroot/wp-config.php" && pass "no code editor in wp-admin" || fail "DISALLOW_FILE_EDIT missing"

echo "Signing in"
curl_ -c "$work/jar" -b "wordpress_test_cookie=WP%20Cookie%20check" -o /dev/null "https://$host/wp-login.php"
curl_ -c "$work/jar" -b "$work/jar" -b "wordpress_test_cookie=WP%20Cookie%20check" -o /dev/null --data-urlencode "log=owner" --data-urlencode "pwd=$password" -d "testcookie=1&wp-submit=Log+In" "https://$host/wp-login.php"
grep -q "Dashboard" <<<"$(curl_ -b "$work/jar" "https://$host/wp-admin/")" && pass "the owner signs in with the one-time password" || fail "sign-in failed"

echo "Password guessing"
for i in 1 2 3; do curl_ -o /dev/null --data-urlencode "log=owner" --data-urlencode "pwd=wrong$i" -d "testcookie=1" -b "wordpress_test_cookie=WP%20Cookie%20check" "https://$host/wp-login.php"; done
sleep 2
fail2ban-client status layer-wordpress >/dev/null 2>&1 && pass "the WordPress sign-in jail runs" || fail "no layer-wordpress jail" "$(fail2ban-client status 2>&1)"
matches="$(fail2ban-regex "/var/log/caddy/$slug.log" /etc/fail2ban/filter.d/layer-wordpress.conf 2>/dev/null | sed -n 's/^Failregex: \([0-9]*\) total.*/\1/p')"
[[ "${matches:-0}" -ge 3 ]] && pass "failed sign-ins are counted ($matches), the good one isn't" || fail "fail2ban counted ${matches:-0} failed sign-ins"

echo "Media, served by Caddy"
php -r '$i = imagecreatetruecolor(20, 20); imagepng($i, "/tmp/wp-e2e.png");' 2>/dev/null || printf '\x89PNG\r\n\x1a\n' >/tmp/wp-e2e.png
install -o "app-$slug" -m 644 /tmp/wp-e2e.png "/srv/apps/$slug/data/wp-e2e.png"
media_url="$(wp media import "/srv/apps/$slug/data/wp-e2e.png" --porcelain=url 2>&1 | tail -1)"
path="${media_url#https://$host}"
[[ "$(code "$path")" == 200 ]] && pass "an uploaded image is served ($path)" || fail "upload not served: $media_url $(code "$path")"

echo "Plugins, and Lock code"
wp plugin install classic-editor --activate >/dev/null 2>&1 && pass "a plugin installs from wordpress.org" || fail "plugin install failed"
expect "Lock code" "$(call wordpress.config "{\"slug\":\"$slug\",\"locked\":true}")" '.ok == true'
[[ "$(wp eval 'echo current_user_can("install_plugins") ? "yes" : "no";' --user=owner)" == no ]] && pass "locked: wp-admin can't install plugins" || fail "still can install plugins"
call wordpress.config "{\"slug\":\"$slug\",\"locked\":false}" >/dev/null
out="$(call wordpress.status "{\"slug\":\"$slug\"}")"
expect "wordpress.status" "$out" ".ok == true and .result.version == \"$version\" and (.result.plugins | map(.name) | index(\"classic-editor\") != null)"

echo "A new owner password"
out="$(call wordpress.run "{\"slug\":\"$slug\",\"op\":\"reset-password\",\"user\":\"owner\"}")"
expect "reset-password" "$out" '.ok == true'
new="$(jq -r .result.password <<<"$out")"
[[ "$(wp user check-password owner "$new" >/dev/null 2>&1 && echo ok)" == ok ]] && pass "the new password works" || fail "new password doesn't work"
out="$(call wordpress.run "{\"slug\":\"$slug\",\"op\":\"ls\"}")"
expect "only allowlisted wp-cli commands" "$out" '.ok == false'

echo "WP-Cron from a timer"
systemctl is-enabled --quiet "app-$slug-wpcron.timer" && pass "the timer is on" || fail "no WP-Cron timer"
systemctl start "app-$slug-wpcron.service" && pass "WP-Cron runs as the site" || fail "WP-Cron failed" "$(journalctl -u "app-$slug-wpcron" -n 5 --no-pager)"

echo "Bringing a site in (wp-content and a .sql dump, another table prefix and address)"
mkdir -p "$work/old/site/wp-content/uploads"
echo "old upload" >"$work/old/site/wp-content/uploads/old.txt"
wp db export - --skip-plugins --skip-themes 2>/dev/null | sed -e 's/`wp_/`old_/g' -e "s#https://$host#https://old.example.com#g" >"$work/old/site/backup.sql"
tar -czf "$work/old.tar.gz" -C "$work/old" site
name="$slug-$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 4).tar.gz"
install -d -o layer -g layer -m 700 "$restore_dir"
install -o layer -g layer -m 600 "$work/old.tar.gz" "$restore_dir/$name"
out="$(call wordpress.import "{\"slug\":\"$slug\",\"file\":\"$name\"}")"
rm -f "$restore_dir/$name"
expect "wordpress.import" "$out" '.ok == true and .result.prefix == "old_" and .result.oldUrl == "https://old.example.com" and .result.replaced > 0'
grep -q "table_prefix = 'old_'" "$docroot/wp-config.php" && pass "wp-config.php has the dump's table prefix" || fail "table prefix not set"
[[ "$(wp option get home)" == "https://$host" ]] && pass "the old address now points here" || fail "home: $(wp option get home)"
[[ "$(curl_ "https://$host/wp-content/uploads/old.txt")" == "old upload" ]] && pass "its uploads are served" || fail "old upload not served"
[[ -f "$docroot/wp-content/mu-plugins/layer-mail.php" && -d "$docroot/wp-content.before-import" ]] && pass "the mail plugin stays, the old wp-content is kept aside" || fail "mu-plugin or before-import missing"
grep -q "Test Blog" <<<"$(curl_ "https://$host/")" && pass "the site answers after the import" || fail "site down after import"

echo "Back up and restore"
post="$(wp post create --post_title='Before the backup' --post_status=publish --porcelain)"
out="$(call backup.snapshot "{\"slug\":\"$slug\"}")"
expect "snapshot (files and the database dump)" "$out" '.ok == true'
file="$(jq -r .result.file <<<"$out")"
wp post delete "$post" --force >/dev/null
install -d -o layer -g layer -m 700 "$restore_dir"
install -o layer -g layer -m 600 "$staging/$file" "$restore_dir/$file"
expect "restore" "$(call backup.restore "{\"slug\":\"$slug\",\"file\":\"$file\"}")" '.ok == true'
[[ "$(wp post get "$post" --field=post_title 2>/dev/null)" == "Before the backup" ]] && pass "the post is back (database restored)" || fail "post not restored"
[[ "$(code "$path")" == 200 ]] && pass "and the image is served again (Caddy's access re-applied)" || fail "image not served after restore: $(code "$path")"
grep -q "Test Blog" <<<"$(curl_ "https://$host/")" && pass "the site answers after the restore" || fail "site down after restore"
rm -f "$staging/$file" "$restore_dir/$file"

echo "Delete"
expect "app.delete" "$(call app.delete "{\"slug\":\"$slug\",\"keepData\":false}")" '.ok == true'
[[ ! -e /etc/systemd/system/app-$slug-wpcron.timer && ! -e /etc/systemd/system/app-$slug-php.service ]] && pass "its PHP and WP-Cron are gone" || fail "leftover units"

rm -rf "$work"
if ((failures)); then echo "$failures check(s) failed"; exit 1; fi
echo "All WordPress checks passed"

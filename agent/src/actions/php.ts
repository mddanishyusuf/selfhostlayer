// PHP for Sites (WordPress): PHP from the distro, installed once, and one
// sandboxed PHP-FPM master per site, as the site's own user, on a socket only
// Caddy can reach. See PLAN-SITES.md.
import { chownSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertSlug } from "@layer/protocol";
import type { ActionTable, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { childOf, lookupUser, removeManaged, writeFileAtomic } from "../fsutil.ts";
import { sandboxArgs, SYSTEMD_RUN } from "../sandbox.ts";
import { assertPhpSettings, phpSocketDir, phpUnitName, renderPhpFpmConf, renderPhpUnit, type PhpSettings } from "../templates/php.ts";
import { appLayout } from "./app.ts";

/** What PHP's install adds: FPM, the CLI (for wp-cli), WordPress's extensions, and setfacl for Caddy's access. */
const PACKAGES = ["php-fpm", "php-cli", "php-mysql", "php-curl", "php-gd", "php-imagick", "php-intl", "php-mbstring", "php-xml", "php-zip", "acl"];

export interface PhpInstall {
  version: string;
  fpm: string;
}

/** The installed PHP, or null. */
export function phpInstalled(ctx: Context): PhpInstall | null {
  try {
    const state = JSON.parse(readFileSync(ctx.paths.phpState, "utf8")) as PhpInstall;
    return existsSync(state.fpm) ? state : null;
  } catch {
    return null;
  }
}

/** The newest php-fpmX.Y in /usr/sbin. */
function findFpm(): PhpInstall | null {
  const versions = readdirSync("/usr/sbin")
    .map((n) => /^php-fpm(\d+\.\d+)$/.exec(n)?.[1])
    .filter((v): v is string => !!v)
    .sort((a, b) => Number(b.split(".")[0]) - Number(a.split(".")[0]) || Number(b.split(".")[1]) - Number(a.split(".")[1]));
  return versions[0] ? { version: versions[0], fpm: `/usr/sbin/php-fpm${versions[0]}` } : null;
}

function apt(ctx: Context, args: string[], unit: string) {
  return ctx.exec(
    SYSTEMD_RUN,
    ["--quiet", "--wait", "--pipe", "--collect", `--unit=${unit}`, "--setenv=DEBIAN_FRONTEND=noninteractive", "--setenv=NEEDRESTART_MODE=a", "--", BIN.aptGet, ...args],
    { timeoutMs: 900_000, allowFail: true },
  );
}

/**
 * fail2ban for WordPress logins: Caddy's JSON access logs, a POST to
 * wp-login.php that answers 200 (a failed sign-in; a good one redirects).
 * 10 in 10 minutes from one address bans it for an hour.
 */
export const WP_FILTER = `# Managed by Self Host Layer: failed WordPress sign-ins, from Caddy's JSON access logs.
[Definition]
datepattern = "ts":{EPOCH}
failregex = ^\{.*"client_ip":"<HOST>".*"method":"POST".*"uri":"/wp-login\.php[^"]*".*"status":200[,}]
ignoreregex =
`;
export const WP_JAIL = `# Managed by Self Host Layer.
[layer-wordpress]
enabled = true
backend = auto
filter = layer-wordpress
logpath = /var/log/caddy/*.log
port = http,https
maxretry = 10
findtime = 10m
bantime = 1h
`;

async function wordpressJail(ctx: Context): Promise<void> {
  if (!existsSync("/etc/fail2ban/jail.d")) return;
  writeFileAtomic("/etc/fail2ban/filter.d/layer-wordpress.conf", WP_FILTER, 0o644);
  writeFileAtomic("/etc/fail2ban/jail.d/layer-wordpress.conf", WP_JAIL, 0o644);
  await ctx.exec(BIN.systemctl, ["reload-or-restart", "fail2ban"], { allowFail: true });
}

/** A PHP site's access log exists before fail2ban looks (it only watches files that exist), then the jail reads it. */
export async function watchLogins(ctx: Context, slug: string): Promise<void> {
  if (!existsSync("/etc/fail2ban/jail.d/layer-wordpress.conf")) return;
  const log = join(ctx.paths.caddyLogDir, `${slug}.log`);
  const caddy = await lookupUser(ctx.exec, ctx.paths.staticGroup ?? "caddy");
  if (!existsSync(log) && caddy) {
    writeFileAtomic(log, "", 0o640);
    chownSync(log, caddy.uid, caddy.gid);
  }
  await ctx.exec(BIN.fail2banClient, ["reload", "layer-wordpress"], { allowFail: true });
}

export async function installPhp(ctx: Context) {
  const already = phpInstalled(ctx);
  if (already) {
    if (!existsSync("/etc/fail2ban/jail.d/layer-wordpress.conf")) await wordpressJail(ctx);
    return { name: "php", installed: true, version: already.version, already: true };
  }
  await apt(ctx, ["update", "-q"], "layer-apt-update");
  const r = await apt(ctx, ["install", "-y", "-q", "--no-install-recommends", ...PACKAGES], "layer-apt-install");
  const found = findFpm();
  if (r.code !== 0 || !found) throw new ActionError("install_failed", `couldn't install PHP with apt: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
  // The distro's shared FPM stays off: every site runs its own.
  await ctx.exec(BIN.systemctl, ["disable", "--now", `php${found.version}-fpm.service`], { allowFail: true });
  writeFileAtomic(ctx.paths.phpState, JSON.stringify(found) + "\n", 0o644);
  await wordpressJail(ctx);
  return { name: "php", installed: true, version: found.version, already: false };
}

const settingsFile = (ctx: Context, slug: string) => join(appLayout(ctx, slug).etcDir, "php.json");

/** A PHP site's settings (from php.write), or null for any other app. */
export function phpSettings(ctx: Context, slug: string): PhpSettings | null {
  try {
    return JSON.parse(readFileSync(settingsFile(ctx, slug), "utf8")) as PhpSettings;
  } catch {
    return null;
  }
}

/**
 * Lets Caddy read the site's files and nothing else: traverse the app's
 * folder and data/, read the docroot (and what PHP writes there later, by
 * default ACLs), never the private files. Run as the site's own user, so it
 * can only ever touch the site's own files: a symlink can't send it anywhere.
 */
const ACCESS_SCRIPT = [
  "set -eu",
  'app="$1" data="$2" root="$3" caddy="$4"',
  "shift 4",
  'mkdir -p -- "$root"',
  'setfacl -m "u:$caddy:x" -- "$app" "$data"',
  'setfacl -R -P -m "u:$caddy:rX" -- "$root"',
  'find "$root" -type d -exec setfacl -m "d:u:$caddy:rX" -- {} +',
  'for f in "$@"; do if [ -f "$root/$f" ] && [ ! -L "$root/$f" ]; then setfacl -x "u:$caddy" -- "$root/$f"; fi; done',
].join("\n");

export async function phpAccess(ctx: Context, slug: string): Promise<void> {
  const s = phpSettings(ctx, slug);
  const caddy = ctx.paths.staticGroup;
  if (!s || !caddy) return;
  const app = appLayout(ctx, slug);
  const user = await lookupUser(ctx.exec, app.user);
  if (!user) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  let output = "";
  const { code } = await ctx.spawn(
    SYSTEMD_RUN,
    sandboxArgs({
      unit: `layer-access-${slug}.service`,
      user: user.name,
      cwd: app.appDir,
      readWrite: [app.appDir],
      env: { PATH: "/usr/bin:/bin" },
      memoryMb: 128,
      timeoutSec: 300,
      network: false,
      command: ["/bin/sh", "-c", ACCESS_SCRIPT, "layer-access", app.appDir, app.data, join(app.data, s.root), caddy, ...s.private],
    }),
    { onData: (chunk) => (output += chunk) },
  );
  if (code !== 0) throw new ActionError("access_failed", `setting Caddy's access to ${slug}'s files failed (exit ${code}): ${output.trim().split("\n").at(-1) ?? ""}`);
}

/**
 * Writes the site's FPM config and unit, gives Caddy read access to its
 * docroot, and (re)starts it. Type=notify: when this returns, the socket is up.
 */
export async function phpWrite(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const s = assertPhpSettings(params);
  const app = appLayout(ctx, slug);
  if (!existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  const php = phpInstalled(ctx);
  if (!php) throw new ActionError("not_installed", "PHP isn't installed yet (service.install php)");
  const caddy = ctx.paths.staticGroup ?? "caddy";
  writeFileAtomic(settingsFile(ctx, slug), JSON.stringify(s, null, 2) + "\n", 0o644);
  writeFileAtomic(join(app.etcDir, "php-fpm.conf"), renderPhpFpmConf(slug, s, ctx.paths.phpRunRoot), 0o644);
  writeFileAtomic(join(ctx.paths.systemdDir, phpUnitName(slug)), renderPhpUnit(slug, s, php.fpm, ctx.paths.phpRunRoot, caddy), 0o644);
  await ctx.exec(BIN.systemctl, ["daemon-reload"]);
  await phpAccess(ctx, slug);
  await ctx.exec(BIN.systemctl, ["enable", phpUnitName(slug)], { allowFail: true });
  const r = await ctx.exec(BIN.systemctl, ["restart", phpUnitName(slug)], { allowFail: true, timeoutMs: 60_000 });
  if (r.code !== 0) {
    const log = await ctx.exec(BIN.journalctl, ["-u", phpUnitName(slug), "-n", "5", "--no-pager", "-o", "cat"], { allowFail: true });
    throw new ActionError("start_failed", `${slug}'s PHP didn't start: ${log.stdout.trim().split("\n").slice(-3).join(" ") || r.stderr.trim()}`);
  }
  return { slug, version: php.version, socket: `${phpSocketDir(ctx.paths.phpRunRoot, slug)}/php.sock`, ...s };
}

/** Stops and removes a site's PHP (app.delete calls it too). */
export async function removePhp(ctx: Context, slug: string): Promise<boolean> {
  const unit = join(ctx.paths.systemdDir, phpUnitName(slug));
  const had = existsSync(unit) || existsSync(settingsFile(ctx, slug));
  await ctx.exec(BIN.systemctl, ["disable", "--now", phpUnitName(slug)], { allowFail: true });
  if (existsSync(unit)) {
    removeManaged(unit);
    await ctx.exec(BIN.systemctl, ["daemon-reload"]);
  }
  const etc = appLayout(ctx, slug).etcDir;
  for (const f of ["php-fpm.conf", "php.json"]) removeManaged(childOf(etc, f));
  return had;
}

async function phpRemove(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  return { slug, removed: await removePhp(ctx, slug) };
}

async function phpStatus(params: Params, ctx: Context) {
  const php = phpInstalled(ctx);
  if (params.slug === undefined) return { installed: !!php, version: php?.version ?? null };
  const slug = assertSlug(params.slug);
  const settings = phpSettings(ctx, slug);
  const active = settings ? (await ctx.exec(BIN.systemctl, ["is-active", phpUnitName(slug)], { allowFail: true })).stdout.trim() : "inactive";
  return { slug, installed: !!php, version: php?.version ?? null, settings, active: active === "active" };
}

export const phpActions: ActionTable = {
  "php.write": { mutates: true, run: phpWrite },
  "php.remove": { mutates: true, run: phpRemove },
  "php.status": { mutates: false, run: phpStatus },
};

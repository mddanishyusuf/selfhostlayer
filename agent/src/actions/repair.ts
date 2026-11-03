// `layer repair`: puts back every generated file someone edited or deleted by
// hand (units, Caddy sites, env files), from the copies the agent keeps as it
// writes them (fsutil.ts), then reloads or restarts only what those files
// touch. Works even when the panel doesn't. /etc/layer/config.json isn't one:
// the installer writes it too, and a re-run of the installer repairs it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Paths } from "../config.ts";
import type { ActionTable, Context } from "../context.ts";
import { BIN } from "../exec.ts";
import { listManaged, writeFileAtomic } from "../fsutil.ts";
import { MYSQL8 } from "../templates/mysql8.ts";
import { phpUnitName } from "../templates/php.ts";
import { redisUnit } from "../templates/redis.ts";

// Apps' colors and cron jobs, a Sites WordPress's PHP and WP-Cron, Redis per app, MySQL 8.
const AGENT_UNIT = /^(app-[a-z0-9-]+(@\.service|-cron-[a-z0-9-]+\.(service|timer)|-worker-[a-z0-9-]+\.service|-php\.service|-wpcron\.(service|timer))|layer-redis-[a-z0-9-]+\.service|layer-mysql8\.service)$/;

/** The files only the agent writes. The installer's own (layer-agent.service, config.json, …) are left to a re-run of it. */
export function ownsPath(paths: Paths): (path: string) => boolean {
  return (path) =>
    (dirname(path) === paths.caddySitesDir && path.endsWith(".caddy")) ||
    path.startsWith(`${paths.appEtcRoot}/`) ||
    path === MYSQL8.conf ||
    (dirname(path) === paths.systemdDir && AGENT_UNIT.test(basename(path)));
}

/** Candidates for adoption at start: what's on disk where the agent writes. */
export function filesOnDisk(paths: Paths): string[] {
  const ls = (dir: string) => (existsSync(dir) ? readdirSync(dir).map((n) => join(dir, n)) : []);
  return [...ls(paths.caddySitesDir), ...ls(paths.systemdDir), ...ls(paths.appEtcRoot).flatMap(ls)];
}

function unchanged(path: string, content: string, mode: number): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o777) === mode && readFileSync(path, "utf8") === content;
  } catch {
    return false;
  }
}

async function systemRepair(_params: unknown, ctx: Context) {
  const { paths } = ctx;
  const restored: string[] = [];
  for (const r of listManaged()) {
    if (unchanged(r.path, r.content, r.mode)) continue;
    writeFileAtomic(r.path, r.content, r.mode);
    restored.push(r.path);
  }
  if (restored.some((p) => dirname(p) === paths.systemdDir)) await ctx.exec(BIN.systemctl, ["daemon-reload"]);
  if (restored.some((p) => dirname(p) === paths.caddySitesDir)) await ctx.exec(BIN.systemctl, ["reload", "caddy"], { allowFail: true, timeoutMs: 120_000 });

  // What the restored files feed: the app's running colors, its Redis, its timers.
  const restart = new Set<string>();
  const appColors = async (slug: string) => {
    for (const color of ["blue", "green"]) {
      const unit = `app-${slug}@${color}.service`;
      const { stdout } = await ctx.exec(BIN.systemctl, ["is-active", unit], { allowFail: true });
      if (stdout.trim() === "active") restart.add(unit);
    }
  };
  for (const p of restored) {
    const name = basename(p);
    const unit = AGENT_UNIT.exec(name);
    if (dirname(p) === paths.systemdDir && unit) {
      const app = /^app-([a-z0-9-]+)@\.service$/.exec(name);
      if (app) await appColors(app[1]!);
      else if (name.endsWith(".timer") || name.startsWith("layer-redis-") || name.endsWith("-php.service") || name === MYSQL8.unit) restart.add(name);
    } else if (p.startsWith(`${paths.appEtcRoot}/`)) {
      const slug = relative(paths.appEtcRoot, p).split("/")[0]!;
      if (name === "redis.conf") restart.add(redisUnit(slug));
      else if (name === "php-fpm.conf" || name === "php.json") restart.add(phpUnitName(slug));
      else if (name === "wordpress.json") continue;
      else await appColors(slug);
    } else if (p === MYSQL8.conf) {
      restart.add(MYSQL8.unit);
    }
  }
  for (const unit of restart) await ctx.exec(BIN.systemctl, ["restart", unit], { allowFail: true });
  return { checked: listManaged().length, restored, restarted: [...restart] };
}

export const repairActions: ActionTable = {
  "system.repair": { mutates: true, run: systemRepair },
};

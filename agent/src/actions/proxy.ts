import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { assertColor, assertSlug, ValidationError } from "@layer/protocol";
import type { ActionTable, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { childOf, ensureDir, removeManaged, writeFileAtomic } from "../fsutil.ts";
import { assertDomains, assertRedirects, renderCaddySite, renderStaticSite } from "../templates/caddy-site.ts";
import { parseColorEnvPort } from "../templates/env-file.ts";
import { assertBlocks, phpSocketDir, renderPhpSite } from "../templates/php.ts";
import { appLayout } from "./app.ts";
import { phpSettings } from "./php.ts";

/**
 * Sends the app's domains to one color by rewriting its Caddy site and
 * reloading Caddy. Caddy reloads gracefully: requests in flight finish on the
 * old upstream. If Caddy refuses the config, the previous file is restored.
 */
async function proxySet(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const domains = assertDomains(params.domains);
  const app = appLayout(ctx, slug);
  if (!existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);

  let content: string;
  let target: Record<string, unknown>;
  if (params.php === true) {
    // A PHP site (Sites' WordPress), its FPM written by php.write.
    const settings = phpSettings(ctx, slug);
    if (!settings) throw new ActionError("not_found", `${slug} has no PHP yet (run php.write first)`);
    const redirects = assertRedirects(params.redirects, domains);
    const block = assertBlocks(params.block);
    const socket = `${phpSocketDir(ctx.paths.phpRunRoot, slug)}/php.sock`;
    content = renderPhpSite({ slug, domains, redirects, docroot: join(app.data, settings.root), socket, block, uploadMb: settings.uploadMb });
    target = { php: true, block, redirects };
  } else if (params.static === true) {
    // A static site, published by static.publish.
    const root = join(childOf(ctx.paths.staticRoot, slug), "current");
    if (!existsSync(root)) throw new ActionError("not_found", `${slug} has no published static site yet (run static.publish first)`);
    if (params.spa !== undefined && typeof params.spa !== "boolean") throw new ValidationError("spa", "must be true or false");
    const spa = params.spa === true;
    const redirects = assertRedirects(params.redirects, domains);
    content = renderStaticSite({ slug, domains, spa, root, redirects });
    target = { static: true, spa, redirects };
  } else {
    const color = assertColor(params.color);
    const port = existsSync(app.colorEnv(color)) ? parseColorEnvPort(readFileSync(app.colorEnv(color), "utf8")) : null;
    if (port === null) throw new ActionError("not_found", `no port for ${color}`);
    const redirects = assertRedirects(params.redirects, domains);
    content = renderCaddySite({ slug, color, port, domains, redirects });
    target = { color, port, redirects };
  }

  ensureDir(ctx.paths.caddySitesDir, 0o755);
  const site = childOf(ctx.paths.caddySitesDir, `${slug}.caddy`);
  const previous = existsSync(site) ? readFileSync(site, "utf8") : null;
  writeFileAtomic(site, content, 0o644);

  const reload = await ctx.exec(BIN.systemctl, ["reload", "caddy"], { allowFail: true, timeoutMs: 120_000 });
  if (reload.code !== 0) {
    if (previous === null) removeManaged(site);
    else writeFileAtomic(site, previous, 0o644);
    await ctx.exec(BIN.systemctl, ["reload", "caddy"], { allowFail: true, timeoutMs: 120_000 });
    throw new ActionError("invalid_config", "Caddy refused the new config, so the previous one was kept (see journalctl -u caddy)");
  }
  if (params.php !== true) pointCurrent(app.appDir, params.static === true ? staticSha(ctx, slug) : liveSha(app.appDir, String(params.color)));
  return { slug, domains, ...target };
}

/** The sha a color points at (blue → releases/<sha>). */
function liveSha(appDir: string, color: string): string | null {
  try {
    return basename(readlinkSync(join(appDir, color)));
  } catch {
    return null;
  }
}

/** The sha of the published static release (/srv/static/<slug>/current → <sha>-<time>). */
function staticSha(ctx: Context, slug: string): string | null {
  try {
    return readlinkSync(join(childOf(ctx.paths.staticRoot, slug), "current")).split("-")[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * /srv/apps/<slug>/current → releases/<sha> of whatever is live. Cron jobs run
 * from here. A new symlink renamed over the old one: never follows anything.
 */
function pointCurrent(appDir: string, sha: string | null): void {
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return;
  const tmp = join(appDir, `.current-${randomBytes(4).toString("hex")}`);
  symlinkSync(join("releases", sha), tmp);
  try {
    renameSync(tmp, join(appDir, "current"));
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export const proxyActions: ActionTable = {
  "proxy.set": { mutates: true, run: proxySet },
};

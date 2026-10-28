import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertColor, assertSlug, ValidationError } from "@layer/protocol";
import type { ActionTable, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { childOf, ensureDir, writeFileAtomic } from "../fsutil.ts";
import { assertDomains, assertRedirects, renderCaddySite, renderStaticSite } from "../templates/caddy-site.ts";
import { parseColorEnvPort } from "../templates/env-file.ts";
import { appLayout } from "./app.ts";

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
  if (params.static === true) {
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
    if (previous === null) rmSync(site, { force: true });
    else writeFileAtomic(site, previous, 0o644);
    await ctx.exec(BIN.systemctl, ["reload", "caddy"], { allowFail: true, timeoutMs: 120_000 });
    throw new ActionError("invalid_config", "Caddy refused the new config, so the previous one was kept (see journalctl -u caddy)");
  }
  return { slug, domains, ...target };
}

export const proxyActions: ActionTable = {
  "proxy.set": { mutates: true, run: proxySet },
};

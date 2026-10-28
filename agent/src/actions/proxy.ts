import { existsSync, readFileSync, rmSync } from "node:fs";
import { assertColor, assertSlug } from "@layer/protocol";
import type { ActionTable, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { childOf, ensureDir, writeFileAtomic } from "../fsutil.ts";
import { assertDomains, renderCaddySite } from "../templates/caddy-site.ts";
import { parseColorEnvPort } from "../templates/env-file.ts";
import { appLayout } from "./app.ts";

/**
 * Sends the app's domains to one color by rewriting its Caddy site and
 * reloading Caddy. Caddy reloads gracefully: requests in flight finish on the
 * old upstream. If Caddy refuses the config, the previous file is restored.
 */
async function proxySet(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const color = assertColor(params.color);
  const domains = assertDomains(params.domains);
  const app = appLayout(ctx, slug);
  if (!existsSync(app.colorEnv(color))) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  const port = parseColorEnvPort(readFileSync(app.colorEnv(color), "utf8"));
  if (port === null) throw new ActionError("not_found", `no port for ${color}`);

  ensureDir(ctx.paths.caddySitesDir, 0o755);
  const site = childOf(ctx.paths.caddySitesDir, `${slug}.caddy`);
  const previous = existsSync(site) ? readFileSync(site, "utf8") : null;
  writeFileAtomic(site, renderCaddySite({ slug, color, port, domains }), 0o644);

  const reload = await ctx.exec(BIN.systemctl, ["reload", "caddy"], { allowFail: true, timeoutMs: 120_000 });
  if (reload.code !== 0) {
    if (previous === null) rmSync(site, { force: true });
    else writeFileAtomic(site, previous, 0o644);
    await ctx.exec(BIN.systemctl, ["reload", "caddy"], { allowFail: true, timeoutMs: 120_000 });
    throw new ActionError("invalid_config", "Caddy refused the new config, so the previous one was kept (see journalctl -u caddy)");
  }
  return { slug, color, port, domains };
}

export const proxyActions: ActionTable = {
  "proxy.set": { mutates: true, run: proxySet },
};

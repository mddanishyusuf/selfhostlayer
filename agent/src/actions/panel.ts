// The panel's own address: its Caddy site (/etc/caddy/sites/_panel.caddy) and
// the facts about the box the panel reads (/etc/layer/config.json). The
// installer and Settings → Panel address both go through here, so an update
// never undoes an address set in the panel.
import { chownSync, existsSync, readFileSync, rmSync } from "node:fs";
import { assertDomain } from "@layer/protocol";
import type { ActionTable, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { childOf, ensureDir, lookupGid, writeFileAtomic } from "../fsutil.ts";
import { assertHosts, assertRanges, renderPanelSite } from "../templates/caddy-panel.ts";

export interface BoxFile {
  panelHost: string;
  appsDomain: string;
  publicIp: string;
  version: string;
  defaultNode: string;
  /** Hosts the panel also answers on while it moves there. */
  panelPending?: string[];
  /** Old addresses that redirect to panelHost. */
  panelAliases?: string[];
  internalTls?: boolean;
  /** IPs or ranges the panel answers; empty or missing: anyone. */
  panelAllow?: string[];
}

function readBox(ctx: Context): BoxFile {
  if (!existsSync(ctx.paths.boxConfig)) throw new ActionError("not_found", `${ctx.paths.boxConfig} is missing (re-run the installer)`);
  return JSON.parse(readFileSync(ctx.paths.boxConfig, "utf8")) as BoxFile;
}

/** root:layer 640, like the installer writes it: the panel reads it, apps can't. */
async function writeBox(ctx: Context, box: BoxFile): Promise<void> {
  writeFileAtomic(ctx.paths.boxConfig, JSON.stringify(box, null, 2) + "\n", 0o640);
  const gid = ctx.paths.socketGroup ? await lookupGid(ctx.exec, ctx.paths.socketGroup) : null;
  if (gid !== null) chownSync(ctx.paths.boxConfig, 0, gid);
}

const panelSiteFile = (ctx: Context) => childOf(ctx.paths.caddySitesDir, "_panel.caddy");

/** From the config; installs from before it was recorded there have it in the site. */
function internalTls(ctx: Context, box: BoxFile): boolean {
  if (typeof box.internalTls === "boolean") return box.internalTls;
  const site = panelSiteFile(ctx);
  return existsSync(site) && /^\s*tls internal\s*$/m.test(readFileSync(site, "utf8"));
}

/**
 * Writes the panel's site and config for `next` and reloads Caddy. If Caddy
 * refuses, both files go back to what they were.
 */
async function publish(ctx: Context, next: BoxFile, current: BoxFile): Promise<void> {
  const content = renderPanelSite({
    hosts: [next.panelHost, ...(next.panelPending ?? [])],
    redirects: next.panelAliases ?? [],
    internalTls: next.internalTls === true,
    allow: next.panelAllow ?? [],
  });
  ensureDir(ctx.paths.caddySitesDir, 0o755);
  const site = panelSiteFile(ctx);
  const previous = existsSync(site) ? readFileSync(site, "utf8") : null;
  writeFileAtomic(site, content, 0o644);
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  if (changed) await writeBox(ctx, next);
  const reload = await ctx.exec(BIN.systemctl, ["reload", "caddy"], { allowFail: true, timeoutMs: 120_000 });
  if (reload.code !== 0) {
    if (previous === null) rmSync(site, { force: true });
    else writeFileAtomic(site, previous, 0o644);
    if (changed) await writeBox(ctx, current);
    await ctx.exec(BIN.systemctl, ["reload", "caddy"], { allowFail: true, timeoutMs: 120_000 });
    throw new ActionError("invalid_config", "Caddy refused the new config, so the previous one was kept (see journalctl -u caddy)");
  }
}

const state = (box: BoxFile) => ({ host: box.panelHost, pending: box.panelPending ?? [], aliases: box.panelAliases ?? [], internalTls: box.internalTls === true, allow: box.panelAllow ?? [] });

/** (Re)writes the panel's site from the config, as it is. */
async function panelSite(_params: Params, ctx: Context) {
  const current = readBox(ctx);
  const next: BoxFile = { ...current, internalTls: internalTls(ctx, current) };
  // An alias equal to the address (e.g. after --domain) would clash with it.
  next.panelAliases = (current.panelAliases ?? []).filter((h) => h !== next.panelHost && !(next.panelPending ?? []).includes(h));
  await publish(ctx, next, current);
  return state(next);
}

/**
 * Sets where the panel answers: hosts (the first is its address) and old
 * addresses that redirect there. The panel checks DNS before asking.
 */
async function panelAddress(params: Params, ctx: Context) {
  const hosts = assertHosts(params.hosts, "hosts", 1);
  const redirects = assertHosts(params.redirects ?? [], "redirects", 0);
  const current = readBox(ctx);
  const next: BoxFile = { ...current, panelHost: hosts[0]!, panelPending: hosts.slice(1), panelAliases: redirects, internalTls: internalTls(ctx, current) };
  await publish(ctx, next, current);
  return state(next);
}

/**
 * Who may open the panel: IPs or ranges, or [] for anyone (password and 2FA
 * still apply). The panel refuses lists without the requester's own address;
 * `layer access reset` on the box is the way back from a mistake.
 */
async function panelAccess(params: Params, ctx: Context) {
  const allow = assertRanges(params.allow);
  const current = readBox(ctx);
  const next: BoxFile = { ...current, panelAllow: allow, internalTls: internalTls(ctx, current) };
  await publish(ctx, next, current);
  return state(next);
}

/** The base of every app's free URL (<slug>.<appsDomain>). The panel moves the apps' sites. */
async function appsDomain(params: Params, ctx: Context) {
  // "internal" is the test boxes' domain (apps at <slug>.internal).
  const domain = params.domain === "internal" ? "internal" : assertDomain(params.domain, "domain");
  const current = readBox(ctx);
  if (domain !== current.appsDomain) await writeBox(ctx, { ...current, appsDomain: domain });
  return { appsDomain: domain, previous: current.appsDomain };
}

export const panelActions: ActionTable = {
  "panel.site": { mutates: true, run: panelSite },
  "panel.address": { mutates: true, run: panelAddress },
  "panel.access": { mutates: true, run: panelAccess },
  "apps.domain": { mutates: true, run: appsDomain },
};

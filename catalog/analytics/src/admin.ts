// The admin API, /_admin/…, for the panel: sites, stats and the reports
// behind Analytics' pages (realtime, pages, visits, outbound links, goals,
// revenue), payment providers, and settings. It answers only requests made on
// this server with the token made at install (ANALYTICS_ADMIN_TOKEN); anything
// through Caddy, which always sets X-Forwarded-For, is told it doesn't exist.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { getSetting, setSetting } from "../../lib/db.ts";
import { bearer, InputError, json, readJson } from "../../lib/http.ts";
import { addGoal, getGoal, goalStats, removeGoal, updateGoal } from "./goals.ts";
import { type Ingest, VISIT_ID } from "./ingest.ts";
import { journey, outbound, pagesTable, realtime, visitList } from "./reports.ts";
import { mainCurrency, type Revenue, revenueStats, revenueSummary } from "./revenue.ts";
import type { Sites } from "./sites.ts";
import { filtersOf, live, overview, RANGES, stats, type Range } from "./stats.ts";

export interface Settings {
  /** Events and visits older than this are deleted. */
  keepDays: number;
}

const DEFAULTS: Settings = { keepDays: 365 };

export function readSettings(db: DatabaseSync): Settings {
  const json = getSetting(db, "owner");
  return json ? { ...DEFAULTS, ...(JSON.parse(json) as Partial<Settings>) } : { ...DEFAULTS };
}

export function saveSettings(db: DatabaseSync, input: Record<string, unknown>): Settings {
  const next = readSettings(db);
  if (input.keepDays !== undefined) {
    const days = Number(input.keepDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new InputError("keepDays", "must be 1 to 3650 days");
    next.keepDays = days;
  }
  setSetting(db, "owner", JSON.stringify(next));
  return next;
}

export interface AdminContext {
  db: DatabaseSync;
  sites: Sites;
  ingest: Ingest;
  revenue: Revenue;
  token: string;
  version: string;
  geoSource: () => string | null;
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const authorized = (req: IncomingMessage, token: string) => {
  const given = bearer(req);
  return given !== null && timingSafeEqual(digest(given), digest(token));
};

const idOf = (text: string | null | undefined, what = "site"): number => {
  const id = Number(text);
  if (!Number.isInteger(id) || id < 1) throw new InputError(what, `no such ${what}`, 404);
  return id;
};

const rangeOf = (p: URLSearchParams, fallback: Range = "7d"): Range => {
  const range = p.get("range") ?? fallback;
  if (!(RANGES as readonly string[]).includes(range)) throw new InputError("range", `must be one of ${RANGES.join(", ")}`);
  return range as Range;
};

export async function handleAdmin(req: IncomingMessage, res: ServerResponse, ctx: AdminContext, url: URL): Promise<void> {
  if (req.headers["x-forwarded-for"] !== undefined) return json(res, 404, { error: "not found" });
  if (!authorized(req, ctx.token)) return json(res, 401, { error: "the admin token is missing or wrong" });
  const [, , section, idText] = url.pathname.split("/");
  const p = url.searchParams;
  const site = (text: string | null | undefined) => {
    const s = ctx.sites.byId(idOf(text));
    if (!s) throw new InputError("site", "no such site", 404);
    return s;
  };
  const goal = (text: string | null | undefined) => {
    const g = getGoal(ctx.db, idOf(text, "goal"));
    if (!g) throw new InputError("goal", "no such goal", 404);
    return g;
  };
  /** The site, range and filters a report is for, once the events still in memory are written. */
  const report = () => {
    const s = site(p.get("site"));
    const o = { range: rangeOf(p), filters: filtersOf(p) };
    ctx.ingest.flush();
    return { s, o };
  };
  switch (`${req.method ?? "GET"} ${section ?? ""}${idText !== undefined ? "/:id" : ""}`) {
    case "GET info":
      return json(res, 200, { version: ctx.version, sites: ctx.sites.list().length, geo: ctx.geoSource(), pendingEvents: ctx.ingest.pending });
    case "GET sites": {
      // Events still in memory count too.
      ctx.ingest.flush();
      const counts = overview(ctx.db);
      const seen = new Set((ctx.db.prepare("SELECT DISTINCT site_id id FROM sessions").all() as { id: number }[]).map((r) => r.id));
      return json(res, 200, { sites: ctx.sites.list().map((s) => ({ ...s, ...(counts.get(s.id) ?? { visitors: 0, live: 0 }), seen: seen.has(s.id) })) });
    }
    case "POST sites":
      return json(res, 201, ctx.sites.add(await readJson(req)));
    case "PATCH sites/:id":
      return json(res, 200, ctx.sites.update(site(idText).id, await readJson(req)));
    case "DELETE sites/:id":
      ctx.sites.remove(site(idText).id);
      return json(res, 200, { deleted: true });
    case "GET stats": {
      const { s, o } = report();
      return json(res, 200, { site: s, ...stats(ctx.db, s.id, o), revenue: revenueSummary(ctx.db, s.id, o), goals: goalStats(ctx.db, s.id, o) });
    }
    case "GET live": {
      const s = site(p.get("site"));
      ctx.ingest.flush();
      return json(res, 200, live(ctx.db, s.id));
    }
    case "GET realtime": {
      const s = site(p.get("site"));
      ctx.ingest.flush();
      return json(res, 200, realtime(ctx.db, s.id));
    }
    case "GET pages": {
      const { s, o } = report();
      return json(res, 200, { pages: pagesTable(ctx.db, s.id, { ...o, q: p.get("q") ?? undefined }) });
    }
    case "GET visits": {
      const { s, o } = report();
      const g = p.get("goal") ? goal(p.get("goal")) : null;
      if (g && g.siteId !== s.id) throw new InputError("goal", "no such goal", 404);
      return json(res, 200, visitList(ctx.db, s.id, { ...o, q: p.get("q") ?? undefined, goal: g, paid: p.get("paid") === "1", page: Math.floor(Number(p.get("page"))) || 1 }));
    }
    case "GET visits/:id": {
      const s = site(p.get("site"));
      if (!VISIT_ID.test(idText!)) throw new InputError("visit", "no such visit", 404);
      ctx.ingest.flush();
      const j = journey(ctx.db, s.id, idText!);
      if (!j) throw new InputError("visit", "no such visit (visits are kept as long as Settings says)", 404);
      return json(res, 200, j);
    }
    case "GET outbound": {
      const { s, o } = report();
      return json(res, 200, { links: outbound(ctx.db, s.id, o) });
    }
    case "GET goals": {
      const { s, o } = report();
      return json(res, 200, { goals: goalStats(ctx.db, s.id, o), currency: mainCurrency(ctx.db, s.id) });
    }
    case "POST goals": {
      const body = await readJson(req);
      return json(res, 201, addGoal(ctx.db, site(String(body.site ?? "")).id, body));
    }
    case "PATCH goals/:id":
      return json(res, 200, updateGoal(ctx.db, goal(idText).id, await readJson(req)));
    case "DELETE goals/:id":
      removeGoal(ctx.db, goal(idText).id);
      return json(res, 200, { deleted: true });
    case "GET revenue": {
      const { s, o } = report();
      return json(res, 200, { ...revenueStats(ctx.db, s.id, o), sources: ctx.revenue.sources(s.id) });
    }
    case "GET sources":
      return json(res, 200, { sources: ctx.revenue.sources(site(p.get("site")).id) });
    case "PUT sources": {
      const body = await readJson(req);
      return json(res, 200, await ctx.revenue.setSource(site(String(body.site ?? "")).id, body));
    }
    case "DELETE sources":
      ctx.revenue.removeSource(site(p.get("site")).id, p.get("provider") ?? "");
      return json(res, 200, { deleted: true });
    case "POST sync": {
      const body = await readJson(req);
      const s = site(String(body.site ?? ""));
      return json(res, 200, { results: await ctx.revenue.syncAll(s.id), sources: ctx.revenue.sources(s.id) });
    }
    case "GET settings":
      return json(res, 200, readSettings(ctx.db));
    case "PUT settings":
      return json(res, 200, saveSettings(ctx.db, await readJson(req)));
    default:
      return json(res, 404, { error: "not found" });
  }
}

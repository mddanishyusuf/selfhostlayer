// The admin API, /_admin/…, for the panel: sites, stats, who's on now, and
// settings. It answers only requests made on this server with the token made
// at install (ANALYTICS_ADMIN_TOKEN); anything through Caddy, which always
// sets X-Forwarded-For, is told it doesn't exist.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { getSetting, setSetting } from "../../lib/db.ts";
import { bearer, InputError, json, readJson } from "../../lib/http.ts";
import type { Ingest } from "./ingest.ts";
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
  token: string;
  version: string;
  geoSource: () => string | null;
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const authorized = (req: IncomingMessage, token: string) => {
  const given = bearer(req);
  return given !== null && timingSafeEqual(digest(given), digest(token));
};

const idOf = (text: string | null | undefined): number => {
  const id = Number(text);
  if (!Number.isInteger(id) || id < 1) throw new InputError("site", "no such site", 404);
  return id;
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
  switch (`${req.method ?? "GET"} ${section ?? ""}${idText !== undefined ? "/:id" : ""}`) {
    case "GET info":
      return json(res, 200, { version: ctx.version, sites: ctx.sites.list().length, geo: ctx.geoSource(), pendingEvents: ctx.ingest.pending });
    case "GET sites": {
      // Events still in memory count too.
      ctx.ingest.flush();
      const counts = overview(ctx.db);
      return json(res, 200, { sites: ctx.sites.list().map((s) => ({ ...s, ...(counts.get(s.id) ?? { visitors: 0, live: 0 }) })) });
    }
    case "POST sites":
      return json(res, 201, ctx.sites.add(await readJson(req)));
    case "PATCH sites/:id":
      return json(res, 200, ctx.sites.update(site(idText).id, await readJson(req)));
    case "DELETE sites/:id":
      ctx.sites.remove(site(idText).id);
      return json(res, 200, { deleted: true });
    case "GET stats": {
      const range = p.get("range") ?? "7d";
      if (!(RANGES as readonly string[]).includes(range)) throw new InputError("range", `must be one of ${RANGES.join(", ")}`);
      const s = site(p.get("site"));
      ctx.ingest.flush();
      return json(res, 200, { site: s, ...stats(ctx.db, s.id, { range: range as Range, filters: filtersOf(p) }) });
    }
    case "GET live": {
      const s = site(p.get("site"));
      ctx.ingest.flush();
      return json(res, 200, live(ctx.db, s.id));
    }
    case "GET settings":
      return json(res, 200, readSettings(ctx.db));
    case "PUT settings":
      return json(res, 200, saveSettings(ctx.db, await readJson(req)));
    default:
      return json(res, 404, { error: "not found" });
  }
}

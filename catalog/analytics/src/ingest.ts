// POST /api/event: what /script.js sends from a site's pages, and the visits
// built from it. An event must name a site here and come from a page on its
// domain; bots are dropped before anything is kept. The visitor's address is
// used for its country and for the visitor hash (with the User-Agent, under a
// salt that changes daily and is then thrown away), then forgotten.
//
// A visit is a visitor's events less than 30 minutes apart: open visits are
// kept in memory, and events and visits are written every second (or 200
// events) in one transaction, off the request path. The answer names the
// visit, so a site can pass it into its checkout and the payment is credited
// to it (revenue.ts).
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { getSetting, setSetting } from "../../lib/db.ts";
import { clientIp, type Geo } from "../../lib/geo.ts";
import { InputError } from "../../lib/http.ts";
import { Limiter, limitKey } from "../../lib/limit.ts";
import { readAgent } from "../../lib/ua.ts";
import type { Site, Sites } from "./sites.ts";

export const VISIT_GAP = 30 * 60_000;
/** Events per minute from one visitor address (an IPv6 /64) to one site. */
export const RATE_LIMIT = 300;
/** Events per minute to one site from everywhere: past it, the rest are turned away. */
export const SITE_LIMIT = 12_000;
/** Visits in memory at once (they're written as they change; this only bounds a flood). */
export const OPEN_MAX = 50_000;
/** Events kept for the next write when one fails (a full disk, say). */
const QUEUE_MAX = 100_000;
const NAME = /^[\p{L}\p{N} _.:/-]{1,60}$/u;
/** A visit's id, as the event endpoint answers it (12 base64url characters). */
export const VISIT_ID = /^[\w-]{12}$/;
const PROP_KEY = /^[\w.:-]{1,40}$/;

export interface Visit {
  id: string;
  siteId: number;
  visitor: string;
  startedAt: number;
  endedAt: number;
  pageviews: number;
  events: number;
  entry: string;
  exit: string;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  country: string | null;
  device: string;
  browser: string;
  os: string;
  screen: string | null;
}

interface QueuedEvent {
  siteId: number;
  at: number;
  name: string;
  path: string;
  visitor: string;
  session: string;
  props: string | null;
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The path as counted: no query string or hash, no trailing slash (but /), at most 500 characters. */
export function cleanPath(pathname: string): string {
  // By hand: a regex for trailing slashes takes quadratic time on a long run of them.
  let end = pathname.length;
  while (end > 1 && pathname[end - 1] === "/") end--;
  return (pathname.slice(0, end) || "/").slice(0, 500);
}

/** A screen width in four sizes, as layouts tend to break. */
export function screenOf(width: unknown): string | null {
  const w = Number(width);
  if (!Number.isFinite(w) || w <= 0) return null;
  return w < 576 ? "Phone" : w < 992 ? "Tablet" : w < 1440 ? "Laptop" : "Desktop";
}

/**
 * Up to 10 properties of a custom event, as text of up to 200 characters. An
 * outbound click's url is kept only as an http(s) address (its origin and
 * path), as the panel shows it as a link.
 */
export function propsOf(value: unknown, name = ""): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value).slice(0, 10)) {
    if (PROP_KEY.test(k) && ["string", "number", "boolean"].includes(typeof v)) out[k] = String(v).slice(0, 200);
  }
  if (name === "Outbound link" && out.url !== undefined) {
    try {
      const u = new URL(out.url);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
      out.url = `${u.origin}${u.pathname}`.slice(0, 200);
    } catch {
      delete out.url;
    }
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

const text = (value: string | null, max: number) => (value ? value.trim().slice(0, max) || null : null);

export class Ingest {
  readonly #db: DatabaseSync;
  readonly #sites: Sites;
  readonly #geo: () => Geo | null;
  readonly #batch: number;
  #open = new Map<string, Visit>();
  #events: QueuedEvent[] = [];
  #dirty = new Map<string, Visit>();
  #salt: { day: string; value: string } | null = null;
  readonly #fromAddress = new Limiter(RATE_LIMIT, 60_000);
  readonly #toSite = new Limiter(SITE_LIMIT, 60_000, 10_000);
  #timers: NodeJS.Timeout[] = [];

  constructor(db: DatabaseSync, sites: Sites, geo: () => Geo | null, opts: { flushMs?: number; batch?: number } = {}) {
    this.#db = db;
    this.#sites = sites;
    this.#geo = geo;
    this.#batch = opts.batch ?? 200;
    if (opts.flushMs !== 0) this.#timers.push(setInterval(() => this.#tryFlush(), opts.flushMs ?? 1000));
    this.#timers.push(setInterval(() => this.prune(), 60_000));
    for (const t of this.#timers) t.unref();
  }

  #tryFlush(): void {
    try {
      this.flush();
    } catch (err) {
      console.error(`writing events failed (kept for the next try): ${(err as Error).message}`);
    }
  }

  /** Today's salt, the same for every process (stored), replaced when the day changes. */
  #saltFor(now: number): string {
    const day = utcDay(now);
    if (this.#salt?.day === day) return this.#salt.value;
    const stored = getSetting(this.#db, "salt");
    const parsed = stored ? (JSON.parse(stored) as { day: string; value: string }) : null;
    this.#salt = parsed?.day === day ? parsed : { day, value: randomBytes(16).toString("hex") };
    if (parsed?.day !== day) setSetting(this.#db, "salt", JSON.stringify(this.#salt));
    return this.#salt.value;
  }

  #referrer(value: unknown, site: Site): string | null {
    if (typeof value !== "string" || !value) return null;
    try {
      const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
      return host && !this.#sites.owns(site, host) ? host.slice(0, 253) : null;
    } catch {
      return null;
    }
  }

  /** One event; says whether it was counted and in which visit, or why not (bots are dropped quietly). */
  record(input: Record<string, unknown>, req: IncomingMessage, now = Date.now()): { counted: boolean; reason?: string; visit?: string } {
    const name = typeof input.n === "string" ? input.n.trim() : "";
    if (!NAME.test(name)) throw new InputError("n", "must be pageview, ping or an event name (up to 60 letters, digits, spaces and . _ : / -)");
    const site = typeof input.s === "string" ? this.#sites.byDomain(input.s) : undefined;
    if (!site) throw new InputError("s", "isn't a site Analytics counts here", 404);
    let url: URL;
    try {
      url = new URL(String(input.u));
    } catch {
      throw new InputError("u", "must be the page's address");
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !this.#sites.owns(site, url.hostname)) throw new InputError("u", `the page isn't on ${site.domain}`, 403);
    // A browser says which page sent it: another site's pages can't count as this one's.
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "null") {
      let from = "";
      try {
        from = new URL(origin).hostname;
      } catch {
        // not an origin: refused below
      }
      if (!from || !this.#sites.owns(site, from)) throw new InputError("origin", `isn't on ${site.domain}`, 403);
    }
    const ua = req.headers["user-agent"];
    const agent = readAgent(ua);
    if (agent.bot) return { counted: false, reason: "bot" };
    const ip = clientIp(req);
    if (this.#fromAddress.hit(`${limitKey(ip)}|${site.id}`, now)) throw new InputError("rate", `over ${RATE_LIMIT} events a minute`, 429);
    if (this.#toSite.hit(String(site.id), now)) throw new InputError("rate", `${site.domain} is over ${SITE_LIMIT} events a minute`, 429);
    const visitor = createHash("sha256").update(`${this.#saltFor(now)}|${site.id}|${ip ?? ""}|${ua ?? ""}`).digest("hex").slice(0, 16);
    const key = `${site.id}:${visitor}`;
    let visit = this.#open.get(key);
    const fresh = visit !== undefined && now - visit.endedAt <= VISIT_GAP;
    if (name === "ping") {
      if (!visit || !fresh) return { counted: false };
      visit.endedAt = now;
      this.#dirty.set(visit.id, visit);
      // No visit id: a ping's answer shouldn't say whether this browser has a visit open.
      return { counted: true };
    }
    const path = cleanPath(url.pathname);
    if (!visit || !fresh) {
      if (this.#open.size >= OPEN_MAX) this.prune(now);
      if (this.#open.size >= OPEN_MAX) throw new InputError("rate", "too many visits at once", 429);
      const q = url.searchParams;
      visit = {
        id: randomBytes(9).toString("base64url"),
        siteId: site.id,
        visitor,
        startedAt: now,
        endedAt: now,
        pageviews: 0,
        events: 0,
        entry: path,
        exit: path,
        referrer: this.#referrer(input.r, site),
        utmSource: text(q.get("utm_source") ?? q.get("ref"), 100),
        utmMedium: text(q.get("utm_medium"), 100),
        utmCampaign: text(q.get("utm_campaign"), 100),
        country: ip ? (this.#geo()?.country(ip) ?? null) : null,
        device: agent.device,
        browser: agent.browser,
        os: agent.os,
        screen: screenOf(input.w),
      };
      this.#open.set(key, visit);
    }
    visit.endedAt = now;
    if (name === "pageview") {
      visit.pageviews++;
      visit.exit = path;
    } else visit.events++;
    this.#events.push({ siteId: site.id, at: now, name, path, visitor, session: visit.id, props: name === "pageview" ? null : propsOf(input.p, name) });
    this.#dirty.set(visit.id, visit);
    if (this.#events.length === this.#batch) setImmediate(() => this.#tryFlush());
    return { counted: true, visit: visit.id };
  }

  get pending(): number {
    return this.#events.length;
  }

  /** Writes the queued events and the visits they touched, in one transaction. */
  flush(): number {
    if (!this.#events.length && !this.#dirty.size) return 0;
    const events = this.#events;
    const visits = [...this.#dirty.values()];
    this.#events = [];
    this.#dirty = new Map();
    const insert = this.#db.prepare("INSERT INTO events (site_id, at, name, path, visitor, session, props) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const upsert = this.#db.prepare(
      `INSERT INTO sessions (id, site_id, visitor, started_at, ended_at, pageviews, events, entry, exit, referrer, utm_source, utm_medium, utm_campaign, country, device, browser, os, screen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, pageviews = excluded.pageviews, events = excluded.events, exit = excluded.exit`,
    );
    this.#db.exec("BEGIN");
    try {
      for (const e of events) insert.run(e.siteId, e.at, e.name, e.path, e.visitor, e.session, e.props);
      for (const v of visits) {
        upsert.run(v.id, v.siteId, v.visitor, v.startedAt, v.endedAt, v.pageviews, v.events, v.entry, v.exit, v.referrer, v.utmSource, v.utmMedium, v.utmCampaign, v.country, v.device, v.browser, v.os, v.screen);
      }
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      // Kept for the next try, the newest at most: a write that keeps failing mustn't fill the memory.
      this.#events = [...events, ...this.#events].slice(-QUEUE_MAX);
      for (const v of visits) if (!this.#dirty.has(v.id)) this.#dirty.set(v.id, v);
      throw err;
    }
    return events.length;
  }

  /** Forgets visits that have ended (no event for 30 minutes). */
  prune(now = Date.now()): void {
    for (const [key, visit] of this.#open) if (now - visit.endedAt > VISIT_GAP) this.#open.delete(key);
  }

  close(): void {
    for (const t of this.#timers) clearInterval(t);
    this.flush();
  }
}

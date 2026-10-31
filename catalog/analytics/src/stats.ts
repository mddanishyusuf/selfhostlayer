// A site's stats for today, the last 24 hours (by the hour), or 7, 30 or 90
// days (by the day), all in UTC. Totals (visitors, visits, pageviews, bounce
// rate, visit duration) with the period before for comparison, a series, and
// breakdowns: pages, entry and exit pages, referring sites, UTM tags,
// countries, devices, browsers, OSes, screens and custom events. Filters
// (a page, a source, a country…) narrow everything at once.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { InputError } from "../../lib/http.ts";

export const RANGES = ["today", "24h", "7d", "30d", "90d"] as const;
export type Range = (typeof RANGES)[number];

/** Filters on a visit's own fields, by name in the query string. */
const VISIT_FILTERS = { referrer: "referrer", utm_source: "utm_source", utm_medium: "utm_medium", utm_campaign: "utm_campaign", country: "country", device: "device", browser: "browser", os: "os", screen: "screen", entry: "entry", exit: "exit" } as const;
export const FILTERS = ["page", ...Object.keys(VISIT_FILTERS)] as const;
export type Filters = Partial<Record<(typeof FILTERS)[number], string>>;

const HOUR = 3_600_000;
const DAY = 86_400_000;
const TOP = 100;

export interface Totals {
  visitors: number;
  visits: number;
  pageviews: number;
  /** Visits with one pageview and nothing else, of all visits (0 to 1). */
  bounceRate: number;
  /** Average visit length in milliseconds. */
  duration: number;
}

export interface Row {
  /** "" when there's none (no referrer, an unknown country). */
  name: string;
  visitors: number;
  /** Pageviews for pages, visits for entry and exit pages and visit fields, events for custom events. */
  count: number;
}

export interface Stats {
  range: Range;
  from: number;
  to: number;
  bucket: "hour" | "day";
  total: Totals;
  previous: Totals;
  series: { at: number; visitors: number; visits: number; pageviews: number }[];
  pages: Row[];
  entries: Row[];
  exits: Row[];
  referrers: Row[];
  utmSources: Row[];
  utmMediums: Row[];
  utmCampaigns: Row[];
  countries: Row[];
  devices: Row[];
  browsers: Row[];
  os: Row[];
  screens: Row[];
  events: Row[];
}

export function windowOf(range: Range, now: number): { from: number; to: number; bucket: "hour" | "day" } {
  const to = now + 1;
  if (range === "today") return { from: Math.floor(now / DAY) * DAY, to, bucket: "hour" };
  if (range === "24h") return { from: Math.floor(now / HOUR) * HOUR - 23 * HOUR, to, bucket: "hour" };
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return { from: Math.floor(now / DAY) * DAY - (days - 1) * DAY, to, bucket: "day" };
}

/** The filters from a query string, each checked to be one line of text. */
export function filtersOf(params: URLSearchParams): Filters {
  const out: Filters = {};
  for (const key of FILTERS) {
    const v = params.get(key);
    if (v === null) continue;
    if (v.length > 500 || /[\u0000-\u001f]/.test(v)) throw new InputError(key, "must be one line, at most 500 characters");
    out[key] = v;
  }
  return out;
}

/** SQL for visits (aliased s) in a window with the filters; "" matches a field that's empty. */
function visitWhere(siteId: number, from: number, to: number, f: Filters, column = "s.started_at"): { sql: string; args: SQLInputValue[] } {
  const parts = ["s.site_id = ?", `${column} >= ?`, `${column} < ?`];
  const args: SQLInputValue[] = [siteId, from, to];
  for (const [key, column2] of Object.entries(VISIT_FILTERS) as [keyof typeof VISIT_FILTERS, string][]) {
    const v = f[key];
    if (v === undefined) continue;
    parts.push(v === "" ? `s.${column2} IS NULL` : `s.${column2} = ?`);
    if (v !== "") args.push(v);
  }
  if (f.page !== undefined) {
    parts.push("EXISTS (SELECT 1 FROM events p WHERE p.session = s.id AND p.name = 'pageview' AND p.path = ?)");
    args.push(f.page);
  }
  return { sql: parts.join(" AND "), args };
}

/** SQL for events (aliased e, their visit s) in a window with the filters; a page filter means that page's events. */
function eventWhere(siteId: number, from: number, to: number, f: Filters): { sql: string; args: SQLInputValue[] } {
  const parts = ["e.site_id = ?", "e.at >= ?", "e.at < ?"];
  const args: SQLInputValue[] = [siteId, from, to];
  for (const [key, column] of Object.entries(VISIT_FILTERS) as [keyof typeof VISIT_FILTERS, string][]) {
    const v = f[key];
    if (v === undefined) continue;
    parts.push(v === "" ? `s.${column} IS NULL` : `s.${column} = ?`);
    if (v !== "") args.push(v);
  }
  if (f.page !== undefined) {
    parts.push("e.path = ?");
    args.push(f.page);
  }
  return { sql: parts.join(" AND "), args };
}

function totals(db: DatabaseSync, siteId: number, from: number, to: number, f: Filters): Totals {
  const ev = eventWhere(siteId, from, to, f);
  const views = db.prepare(`SELECT count(DISTINCT e.visitor) v, count(*) n FROM events e JOIN sessions s ON s.id = e.session WHERE ${ev.sql} AND e.name = 'pageview'`).get(...ev.args) as { v: number; n: number };
  const vi = visitWhere(siteId, from, to, f);
  const visits = db
    .prepare(`SELECT count(*) n, coalesce(avg(s.pageviews = 1 AND s.events = 0), 0) bounce, coalesce(avg(s.ended_at - s.started_at), 0) duration FROM sessions s WHERE ${vi.sql}`)
    .get(...vi.args) as { n: number; bounce: number; duration: number };
  return { visitors: views.v, visits: visits.n, pageviews: views.n, bounceRate: visits.bounce, duration: Math.round(visits.duration) };
}

export function stats(db: DatabaseSync, siteId: number, o: { range: Range; filters?: Filters; now?: number }): Stats {
  const now = o.now ?? Date.now();
  const f = o.filters ?? {};
  const { from, to, bucket } = windowOf(o.range, now);
  const size = bucket === "hour" ? HOUR : DAY;
  const q = <T>(sql: string, args: SQLInputValue[]) => db.prepare(sql).all(...args) as T[];
  const ev = eventWhere(siteId, from, to, f);
  const vi = visitWhere(siteId, from, to, f);
  const joined = "FROM events e JOIN sessions s ON s.id = e.session";

  const series = new Map<number, { visitors: number; visits: number; pageviews: number }>();
  for (let at = from; at < to; at += size) series.set(at, { visitors: 0, visits: 0, pageviews: 0 });
  for (const r of q<{ b: number; v: number; n: number }>(`SELECT (e.at / ${size}) * ${size} b, count(DISTINCT e.visitor) v, count(*) n ${joined} WHERE ${ev.sql} AND e.name = 'pageview' GROUP BY b`, ev.args)) {
    const p = series.get(r.b);
    if (p) Object.assign(p, { visitors: r.v, pageviews: r.n });
  }
  for (const r of q<{ b: number; n: number }>(`SELECT (s.started_at / ${size}) * ${size} b, count(*) n FROM sessions s WHERE ${vi.sql} GROUP BY b`, vi.args)) {
    const p = series.get(r.b);
    if (p) p.visits = r.n;
  }

  const visitRows = (column: string) =>
    q<Row>(`SELECT coalesce(s.${column}, '') name, count(DISTINCT s.visitor) visitors, count(*) count FROM sessions s WHERE ${vi.sql} GROUP BY name ORDER BY visitors DESC, count DESC LIMIT ${TOP}`, vi.args);
  const span = to - from;
  return {
    range: o.range,
    from,
    to: now,
    bucket,
    total: totals(db, siteId, from, to, f),
    previous: totals(db, siteId, from - span, from, f),
    series: [...series].map(([at, p]) => ({ at, ...p })),
    pages: q<Row>(`SELECT e.path name, count(DISTINCT e.visitor) visitors, count(*) count ${joined} WHERE ${ev.sql} AND e.name = 'pageview' GROUP BY e.path ORDER BY visitors DESC, count DESC LIMIT ${TOP}`, ev.args),
    entries: visitRows("entry"),
    exits: visitRows("exit"),
    referrers: visitRows("referrer"),
    utmSources: visitRows("utm_source"),
    utmMediums: visitRows("utm_medium"),
    utmCampaigns: visitRows("utm_campaign"),
    countries: visitRows("country"),
    devices: visitRows("device"),
    browsers: visitRows("browser"),
    os: visitRows("os"),
    screens: visitRows("screen"),
    events: q<Row>(`SELECT e.name name, count(DISTINCT e.visitor) visitors, count(*) count ${joined} WHERE ${ev.sql} AND e.name != 'pageview' GROUP BY e.name ORDER BY count DESC LIMIT ${TOP}`, ev.args),
  };
}

/** Who's on a site now: visits with an event or a ping in the last 5 minutes, and the pages they're on. */
export function live(db: DatabaseSync, siteId: number, now = Date.now()): { visitors: number; pages: Row[] } {
  const since = now - 5 * 60_000;
  const visitors = (db.prepare("SELECT count(DISTINCT visitor) n FROM sessions WHERE site_id = ? AND ended_at >= ?").get(siteId, since) as { n: number }).n;
  const pages = db.prepare("SELECT exit name, count(DISTINCT visitor) visitors, count(*) count FROM sessions WHERE site_id = ? AND ended_at >= ? GROUP BY exit ORDER BY visitors DESC LIMIT 20").all(siteId, since) as unknown as Row[];
  return { visitors, pages };
}

/** Visitors over the last 24 hours and live now, for every site at once (the site list). */
export function overview(db: DatabaseSync, now = Date.now()): Map<number, { visitors: number; live: number }> {
  const out = new Map<number, { visitors: number; live: number }>();
  for (const r of db.prepare("SELECT site_id id, count(DISTINCT visitor) n FROM events WHERE at >= ? AND name = 'pageview' GROUP BY site_id").all(now - DAY) as { id: number; n: number }[]) out.set(r.id, { visitors: r.n, live: 0 });
  for (const r of db.prepare("SELECT site_id id, count(DISTINCT visitor) n FROM sessions WHERE ended_at >= ? GROUP BY site_id").all(now - 5 * 60_000) as { id: number; n: number }[]) {
    out.set(r.id, { visitors: out.get(r.id)?.visitors ?? 0, live: r.n });
  }
  return out;
}

/** Deletes events and visits older than the keep window; returns how many went. */
export function prune(db: DatabaseSync, keepDays: number, now = Date.now()): { events: number; visits: number } {
  const cutoff = Math.floor(now / DAY) * DAY - keepDays * DAY;
  const events = Number(db.prepare("DELETE FROM events WHERE at < ?").run(cutoff).changes);
  const visits = Number(db.prepare("DELETE FROM sessions WHERE started_at < ?").run(cutoff).changes);
  return { events, visits };
}

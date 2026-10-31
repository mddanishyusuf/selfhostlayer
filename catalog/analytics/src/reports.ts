// The reports behind Analytics' own pages in the panel: every page with its
// numbers, the visits one by one with what each did, who's on the site now,
// and the links to other sites visitors clicked.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { goalMatch, type Goal } from "./goals.ts";
import { mainCurrency, type Provider } from "./revenue.ts";
import { eventWhere, type Filters, type Range, type Row, visitWhere, windowOf } from "./stats.ts";

export interface PageRow {
  path: string;
  visitors: number;
  pageviews: number;
  /** Visits that started and ended on it. */
  entries: number;
  exits: number;
  /** Of the visits that started on it, the ones that saw nothing else (0 to 1). */
  bounceRate: number;
  /** Average milliseconds until the next page, or the end of the visit. */
  time: number;
}

export const PAGES_MAX = 1000;

/** LIKE's own characters, taken as themselves (with ESCAPE '\'). */
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function pagesTable(db: DatabaseSync, siteId: number, o: { range: Range; filters?: Filters; now?: number; q?: string }): PageRow[] {
  const { from, to } = windowOf(o.range, o.now ?? Date.now());
  // A page filter picks the row; every page's numbers come from all of its views.
  const { page, ...f } = o.filters ?? {};
  const ev = eventWhere(siteId, from, to, f);
  const views = db
    .prepare(
      `WITH v AS (
         SELECT e.path, e.visitor, coalesce(lead(e.at) OVER (PARTITION BY e.session ORDER BY e.at), s.ended_at) - e.at spent
         FROM events e JOIN sessions s ON s.id = e.session WHERE ${ev.sql} AND e.name = 'pageview'
       )
       SELECT path, count(DISTINCT visitor) visitors, count(*) pageviews, avg(spent) time FROM v GROUP BY path`,
    )
    .all(...ev.args) as { path: string; visitors: number; pageviews: number; time: number }[];
  const vi = visitWhere(siteId, from, to, f);
  const entries = new Map((db.prepare(`SELECT s.entry path, count(*) n, sum(s.pageviews = 1 AND s.events = 0) bounces FROM sessions s WHERE ${vi.sql} GROUP BY s.entry`).all(...vi.args) as { path: string; n: number; bounces: number }[]).map((r) => [r.path, r]));
  const exits = new Map((db.prepare(`SELECT s.exit path, count(*) n FROM sessions s WHERE ${vi.sql} GROUP BY s.exit`).all(...vi.args) as { path: string; n: number }[]).map((r) => [r.path, r.n]));
  const q = o.q?.trim().toLowerCase();
  return views
    .filter((v) => (page === undefined || v.path === page) && (!q || v.path.toLowerCase().includes(q)))
    .map((v) => {
      const e = entries.get(v.path);
      return { path: v.path, visitors: v.visitors, pageviews: v.pageviews, entries: e?.n ?? 0, exits: exits.get(v.path) ?? 0, bounceRate: e?.n ? e.bounces / e.n : 0, time: Math.round(v.time ?? 0) };
    })
    .sort((a, b) => b.visitors - a.visitors || b.pageviews - a.pageviews || a.path.localeCompare(b.path))
    .slice(0, PAGES_MAX);
}

export interface VisitRow {
  id: string;
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
  /** Payments credited to it, and their amount in the site's main currency. */
  payments: number;
  revenue: number;
}

const VISIT_COLUMNS = `s.id, s.started_at startedAt, s.ended_at endedAt, s.pageviews, s.events, s.entry, s.exit, s.referrer, s.utm_source utmSource, s.utm_medium utmMedium, s.utm_campaign utmCampaign,
  s.country, s.device, s.browser, s.os, s.screen,
  (SELECT count(*) FROM payments p WHERE p.visit = s.id AND p.site_id = s.site_id) payments,
  (SELECT coalesce(sum(p.amount), 0) FROM payments p WHERE p.visit = s.id AND p.site_id = s.site_id AND p.currency = ?) revenue`;

export const VISITS_PAGE = 50;

/** Visits in a range, newest first, 50 a page: searched, and narrowed to a goal's or to paying ones. */
export function visitList(
  db: DatabaseSync,
  siteId: number,
  o: { range: Range; filters?: Filters; now?: number; q?: string; goal?: Goal | null; paid?: boolean; page?: number },
): { visits: VisitRow[]; total: number; page: number; pageSize: number; currency: string | null } {
  const { from, to } = windowOf(o.range, o.now ?? Date.now());
  const vi = visitWhere(siteId, from, to, o.filters ?? {});
  const parts = [vi.sql];
  const args: SQLInputValue[] = [...vi.args];
  const q = o.q?.trim();
  if (q) {
    const l = like(q);
    parts.push(
      `(s.id = ? OR s.entry LIKE ? ESCAPE '\\' OR s.exit LIKE ? ESCAPE '\\' OR s.referrer LIKE ? ESCAPE '\\' OR s.utm_source LIKE ? ESCAPE '\\' OR s.utm_campaign LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM events x WHERE x.session = s.id AND (x.path LIKE ? ESCAPE '\\' OR x.name LIKE ? ESCAPE '\\')))`,
    );
    args.push(q, l, l, l, l, l, l, l);
  }
  if (o.goal) {
    const m = goalMatch(o.goal, "g");
    parts.push(`EXISTS (SELECT 1 FROM events g WHERE g.session = s.id AND ${m.sql})`);
    args.push(...m.args);
  }
  if (o.paid) parts.push("EXISTS (SELECT 1 FROM payments p WHERE p.visit = s.id AND p.site_id = s.site_id)");
  const where = parts.join(" AND ");
  const total = (db.prepare(`SELECT count(*) n FROM sessions s WHERE ${where}`).get(...args) as { n: number }).n;
  const page = Math.max(1, Math.min(o.page ?? 1, Math.ceil(total / VISITS_PAGE) || 1));
  const currency = mainCurrency(db, siteId);
  const visits = db.prepare(`SELECT ${VISIT_COLUMNS} FROM sessions s WHERE ${where} ORDER BY s.started_at DESC LIMIT ${VISITS_PAGE} OFFSET ${(page - 1) * VISITS_PAGE}`).all(currency, ...args) as unknown as VisitRow[];
  return { visits, total, page, pageSize: VISITS_PAGE, currency };
}

export interface Journey {
  visit: VisitRow;
  currency: string | null;
  /** Its pageviews and events in order; outbound clicks are the event "Outbound link" with props.url. */
  steps: { at: number; name: string; path: string; props: Record<string, string> | null }[];
  payments: { provider: Provider; id: string; at: number; amount: number; currency: string; renewal: boolean }[];
}

/** One visit, with what it did and what it paid. */
export function journey(db: DatabaseSync, siteId: number, id: string): Journey | null {
  const currency = mainCurrency(db, siteId);
  const visit = db.prepare(`SELECT ${VISIT_COLUMNS} FROM sessions s WHERE s.id = ? AND s.site_id = ?`).get(currency, id, siteId) as unknown as VisitRow | undefined;
  if (!visit) return null;
  const steps = (db.prepare("SELECT at, name, path, props FROM events WHERE session = ? AND site_id = ? ORDER BY at, rowid LIMIT 500").all(id, siteId) as { at: number; name: string; path: string; props: string | null }[]).map((e) => ({
    ...e,
    props: e.props ? (JSON.parse(e.props) as Record<string, string>) : null,
  }));
  const payments = (db.prepare("SELECT provider, external_id id, at, amount, currency, renewal FROM payments WHERE site_id = ? AND visit = ? ORDER BY at").all(siteId, id) as unknown as (Omit<Journey["payments"][number], "renewal"> & { renewal: number })[]).map((p) => ({
    ...p,
    renewal: p.renewal === 1,
  }));
  return { visit, currency, steps, payments };
}

export interface Realtime {
  /** Visitors with an event or a ping in the last 5 minutes. */
  visitors: number;
  /** Visitors in the last 30 minutes. */
  recent: number;
  /** The last 30 minutes, by the minute. */
  minutes: { at: number; visitors: number; pageviews: number }[];
  pages: Row[];
  referrers: Row[];
  countries: Row[];
  devices: Row[];
  /** The latest pageviews and events, newest first. */
  latest: { at: number; name: string; path: string; props: Record<string, string> | null; visit: string; country: string | null; device: string; browser: string; referrer: string | null }[];
}

const MINUTE = 60_000;

export function realtime(db: DatabaseSync, siteId: number, now = Date.now()): Realtime {
  const since = now - 5 * MINUTE;
  const from = Math.floor(now / MINUTE) * MINUTE - 29 * MINUTE;
  const visitors = (db.prepare("SELECT count(DISTINCT visitor) n FROM sessions WHERE site_id = ? AND ended_at >= ?").get(siteId, since) as { n: number }).n;
  const recent = (db.prepare("SELECT count(DISTINCT visitor) n FROM events WHERE site_id = ? AND at >= ?").get(siteId, from) as { n: number }).n;
  const minutes = new Map<number, { visitors: number; pageviews: number }>();
  for (let at = from; at <= now; at += MINUTE) minutes.set(at, { visitors: 0, pageviews: 0 });
  for (const r of db.prepare(`SELECT (at / ${MINUTE}) * ${MINUTE} m, count(DISTINCT visitor) v, sum(name = 'pageview') n FROM events WHERE site_id = ? AND at >= ? GROUP BY m`).all(siteId, from) as { m: number; v: number; n: number }[]) {
    const p = minutes.get(r.m);
    if (p) Object.assign(p, { visitors: r.v, pageviews: r.n });
  }
  const top = (column: string, limit: number) =>
    db.prepare(`SELECT coalesce(${column}, '') name, count(DISTINCT visitor) visitors, count(*) count FROM sessions WHERE site_id = ? AND ended_at >= ? GROUP BY name ORDER BY visitors DESC, count DESC LIMIT ${limit}`).all(siteId, since) as unknown as Row[];
  const latest = (
    db
      .prepare(
        `SELECT e.at, e.name, e.path, e.props, e.session visit, s.country, s.device, s.browser, s.referrer
         FROM events e JOIN sessions s ON s.id = e.session WHERE e.site_id = ? AND e.at >= ? ORDER BY e.at DESC, e.rowid DESC LIMIT 50`,
      )
      .all(siteId, from) as (Omit<Realtime["latest"][number], "props"> & { props: string | null })[]
  ).map((e) => ({ ...e, props: e.props ? (JSON.parse(e.props) as Record<string, string>) : null }));
  return { visitors, recent, minutes: [...minutes].map(([at, p]) => ({ at, ...p })), pages: top("exit", 20), referrers: top("referrer", 10), countries: top("country", 10), devices: top("device", 5), latest };
}

export const OUTBOUND = "Outbound link";

/** The links to other sites visitors clicked: each address (no query string), with visitors and clicks. */
export function outbound(db: DatabaseSync, siteId: number, o: { range: Range; filters?: Filters; now?: number }): { url: string; visitors: number; clicks: number }[] {
  const { from, to } = windowOf(o.range, o.now ?? Date.now());
  const ev = eventWhere(siteId, from, to, o.filters ?? {});
  return db
    .prepare(
      `SELECT json_extract(e.props, '$.url') url, count(DISTINCT e.visitor) visitors, count(*) clicks FROM events e JOIN sessions s ON s.id = e.session
       WHERE ${ev.sql} AND e.name = ? AND json_extract(e.props, '$.url') IS NOT NULL GROUP BY url ORDER BY visitors DESC, clicks DESC LIMIT 500`,
    )
    .all(...ev.args, OUTBOUND) as { url: string; visitors: number; clicks: number }[];
}

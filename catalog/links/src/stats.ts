// Click stats over the last 24 hours (by the hour), 7 or 30 days (by the
// day), for every link or one: totals, a series, the top links, referring
// sites, countries, devices, browsers and OSes. Bots are left out unless asked
// for. Days past the keep window come from the daily totals the rollup made.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { utcDay } from "./clicks.ts";
import type { Store } from "./store.ts";

export const RANGES = ["24h", "7d", "30d"] as const;
export type Range = (typeof RANGES)[number];

const HOUR = 3_600_000;
const DAY = 86_400_000;
const DIMENSIONS = { referrers: "referrer", countries: "country", devices: "device", browsers: "browser", os: "os" } as const;
type Dimension = keyof typeof DIMENSIONS;

export interface Count {
  /** "" when there's none (no referrer, an unknown country). */
  name: string;
  clicks: number;
}

export interface Stats {
  range: Range;
  from: number;
  to: number;
  bucket: "hour" | "day";
  total: { clicks: number; visitors: number; bots: number };
  series: { at: number; clicks: number; visitors: number }[];
  links: { id: number; slug: string; clicks: number }[];
  referrers: Count[];
  countries: Count[];
  devices: Count[];
  browsers: Count[];
  os: Count[];
}

type Breakdown = Partial<Record<Dimension, Record<string, number>>>;

const TOP = 20;
const sorted = (m: Map<string, number>, limit = TOP): Count[] =>
  [...m].map(([name, clicks]) => ({ name, clicks })).sort((a, b) => b.clicks - a.clicks || a.name.localeCompare(b.name)).slice(0, limit);

export function stats(db: DatabaseSync, store: Store, o: { range: Range; linkId?: number; bots?: boolean; now?: number }): Stats {
  const now = o.now ?? Date.now();
  const bucket = o.range === "24h" ? "hour" : "day";
  const size = bucket === "hour" ? HOUR : DAY;
  const days = o.range === "7d" ? 7 : 30;
  const from = bucket === "hour" ? Math.floor(now / HOUR) * HOUR - 23 * HOUR : Math.floor(now / DAY) * DAY - (days - 1) * DAY;
  const to = now + 1;
  const where = ["at >= ?", "at < ?"];
  const args: SQLInputValue[] = [from, to];
  if (o.linkId !== undefined) {
    where.push("link_id = ?");
    args.push(o.linkId);
  }
  const people = `${where.join(" AND ")}${o.bots ? "" : " AND bot = 0"}`;
  const q = <T>(sql: string, params: SQLInputValue[] = args) => db.prepare(sql).all(...params) as T[];

  const total = q<{ c: number; v: number }>(`SELECT count(*) c, count(DISTINCT visitor) v FROM clicks WHERE ${people}`)[0]!;
  const bots = q<{ c: number }>(`SELECT count(*) c FROM clicks WHERE ${where.join(" AND ")} AND bot = 1`)[0]!.c;
  const series = new Map<number, { clicks: number; visitors: number }>();
  for (let at = from; at < to; at += size) series.set(at, { clicks: 0, visitors: 0 });
  for (const r of q<{ b: number; c: number; v: number }>(`SELECT (at / ${size}) * ${size} b, count(*) c, count(DISTINCT visitor) v FROM clicks WHERE ${people} GROUP BY b`)) {
    series.set(r.b, { clicks: r.c, visitors: r.v });
  }
  const counts = Object.fromEntries(Object.keys(DIMENSIONS).map((k) => [k, new Map<string, number>()])) as Record<Dimension, Map<string, number>>;
  for (const [key, column] of Object.entries(DIMENSIONS) as [Dimension, string][]) {
    for (const r of q<{ name: string; c: number }>(`SELECT coalesce(${column}, '') name, count(*) c FROM clicks WHERE ${people} GROUP BY name`)) counts[key].set(r.name, r.c);
  }
  const perLink = new Map<number, number>();
  if (o.linkId === undefined) for (const r of q<{ id: number; c: number }>(`SELECT link_id id, count(*) c FROM clicks WHERE ${people} GROUP BY link_id`)) perLink.set(r.id, r.c);

  // Days already rolled up into daily totals.
  const daily = q<{ link_id: number; day: string; clicks: number; visitors: number; bots: number; breakdown: string }>(
    `SELECT * FROM clicks_daily WHERE day >= ? AND day <= ?${o.linkId !== undefined ? " AND link_id = ?" : ""}`,
    [utcDay(from), utcDay(now), ...(o.linkId !== undefined ? [o.linkId] : [])],
  );
  let totalClicks = total.c;
  let totalVisitors = total.v;
  let totalBots = bots;
  for (const d of daily) {
    const clicks = d.clicks + (o.bots ? d.bots : 0);
    totalClicks += clicks;
    totalVisitors += d.visitors;
    totalBots += d.bots;
    const at = Date.parse(`${d.day}T00:00:00Z`);
    const point = series.get(at);
    if (point) {
      point.clicks += clicks;
      point.visitors += d.visitors;
    }
    if (o.linkId === undefined) perLink.set(d.link_id, (perLink.get(d.link_id) ?? 0) + clicks);
    const breakdown = JSON.parse(d.breakdown) as Breakdown;
    for (const key of Object.keys(DIMENSIONS) as Dimension[]) for (const [name, n] of Object.entries(breakdown[key] ?? {})) counts[key].set(name, (counts[key].get(name) ?? 0) + n);
  }

  return {
    range: o.range,
    from,
    to: now,
    bucket,
    total: { clicks: totalClicks, visitors: totalVisitors, bots: totalBots },
    series: [...series].map(([at, p]) => ({ at, ...p })),
    links: [...perLink]
      .map(([id, clicks]) => ({ id, slug: store.byId(id)?.slug ?? "", clicks }))
      .filter((l) => l.slug)
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, TOP),
    referrers: sorted(counts.referrers),
    countries: sorted(counts.countries, 250),
    devices: sorted(counts.devices),
    browsers: sorted(counts.browsers),
    os: sorted(counts.os),
  };
}

/**
 * Raw clicks from before the keep window become daily totals per link
 * (clicks, visitors, bots, and the breakdowns without bots), one day per
 * transaction. Returns what it did, for the cron job's log.
 */
export function rollup(db: DatabaseSync, keepDays: number, now = Date.now()): { days: number; clicks: number } {
  const cutoff = Math.floor(now / DAY) * DAY - (keepDays - 1) * DAY;
  // The day length is written into the SQL: bound, it's a float, and at / DAY wouldn't be whole days.
  const days = (db.prepare(`SELECT DISTINCT at / ${DAY} d FROM clicks WHERE at < ? ORDER BY d`).all(cutoff) as { d: number }[]).map((r) => r.d);
  let moved = 0;
  for (const d of days) {
    const from = d * DAY;
    const to = from + DAY;
    const day = utcDay(from);
    db.exec("BEGIN");
    try {
      const rows = db
        .prepare("SELECT link_id, sum(bot = 0) clicks, count(DISTINCT CASE WHEN bot = 0 THEN visitor END) visitors, sum(bot) bots FROM clicks WHERE at >= ? AND at < ? GROUP BY link_id")
        .all(from, to) as { link_id: number; clicks: number; visitors: number; bots: number }[];
      const breakdowns = new Map<number, Breakdown>();
      for (const [key, column] of Object.entries(DIMENSIONS) as [Dimension, string][]) {
        for (const r of db.prepare(`SELECT link_id, coalesce(${column}, '') name, count(*) c FROM clicks WHERE at >= ? AND at < ? AND bot = 0 GROUP BY link_id, name`).all(from, to) as { link_id: number; name: string; c: number }[]) {
          const b = breakdowns.get(r.link_id) ?? {};
          (b[key] ??= {})[r.name] = r.c;
          breakdowns.set(r.link_id, b);
        }
      }
      for (const r of rows) {
        const existing = db.prepare("SELECT clicks, visitors, bots, breakdown FROM clicks_daily WHERE link_id = ? AND day = ?").get(r.link_id, day) as
          | { clicks: number; visitors: number; bots: number; breakdown: string }
          | undefined;
        const breakdown = breakdowns.get(r.link_id) ?? {};
        if (existing) {
          const old = JSON.parse(existing.breakdown) as Breakdown;
          for (const key of Object.keys(DIMENSIONS) as Dimension[]) for (const [name, n] of Object.entries(old[key] ?? {})) (breakdown[key] ??= {})[name] = (breakdown[key]![name] ?? 0) + n;
        }
        db.prepare("INSERT OR REPLACE INTO clicks_daily (link_id, day, clicks, visitors, bots, breakdown) VALUES (?, ?, ?, ?, ?, ?)").run(
          r.link_id,
          day,
          r.clicks + (existing?.clicks ?? 0),
          r.visitors + (existing?.visitors ?? 0),
          r.bots + (existing?.bots ?? 0),
          JSON.stringify(breakdown),
        );
      }
      moved += Number(db.prepare("DELETE FROM clicks WHERE at >= ? AND at < ?").run(from, to).changes);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return { days: days.length, clicks: moved };
}

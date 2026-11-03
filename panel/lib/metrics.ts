// Usage history for the charts: CPU and memory for every app and for the
// box, sampled by the monitor once a minute. A day is kept at one-minute
// steps, then a week of hourly averages. Disk is measured every 15 minutes.
// Target "box" is the panel's server, "server:<id>" another one; anything else is an app's slug.
import { agent } from "./agent";
import { db } from "./db";
import { listProjects } from "./projects";
import { listServers } from "./servers";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface Sample {
  at: number;
  box: { cpu: { busy: number; total: number }; cpus: number; memoryMb: { used: number; total: number }; diskGb: { used: number; total: number } };
  apps: Record<string, { cpuNs: number; memoryMb: number }>;
}

export interface Point {
  at: number;
  /** % of the whole server. */
  cpu: number | null;
  memoryMb: number | null;
}

// On globalThis: Next loads modules twice, and the previous samples must be shared (one per server).
const state: { last: Map<string, Sample>; lastDisk: number } = ((globalThis as { layerMetrics?: { last: Map<string, Sample>; lastDisk: number } }).layerMetrics ??= { last: new Map(), lastDisk: 0 });
if (!(state.last instanceof Map)) state.last = new Map();

const round = (n: number) => Math.round(n * 10) / 10;

/** CPU % between two cumulative readings; null across a restart (the counter starts over). */
export function cpuPercent(before: number | undefined, now: number, wallMs: number, cpus: number): number | null {
  if (before === undefined || wallMs <= 0 || now < before) return null;
  return round(Math.min(100, (100 * (now - before)) / (wallMs * 1e6) / Math.max(1, cpus)));
}

/** The metrics target for a server's whole box: "box" for the panel's own, "server:<id>" for another. */
export const boxTarget = (serverId: number | null) => (serverId === null ? "box" : `server:${serverId}`);

/**
 * One sample for every app and every server's box. The monitor calls it every
 * minute. Each server answers for its own apps; one that doesn't answer is
 * skipped (the monitor's server check raises that).
 */
export async function sampleMetrics(now = Date.now()): Promise<void> {
  const projects = listProjects().filter((p) => p.runtime.kind !== "static");
  const servers: (number | null)[] = [null, ...listServers().filter((s) => s.seenAt).map((s) => s.id)];
  const diskDue = now - state.lastDisk >= 15 * MINUTE;
  if (diskDue) state.lastDisk = now;
  for (const server of servers) {
    const slugs = projects.filter((p) => p.serverId === server).map((p) => p.slug);
    try {
      await sampleServer(server, slugs, diskDue);
    } catch (err) {
      if (server === null) throw err;
    }
  }
  rollUp(now);
}

async function sampleServer(server: number | null, slugs: string[], diskDue: boolean): Promise<void> {
  const s = await agent<Sample>("metrics.sample", { slugs }, { server });
  const key = boxTarget(server);
  const prev = state.last.get(key) ?? null;
  state.last.set(key, s);
  const minute = Math.floor(s.at / MINUTE) * MINUTE;
  // Two samples in one minute (a restart): the later one wins, but keeps what it didn't measure.
  const insert = db().prepare(
    `INSERT INTO metrics (target, step, at, cpu, memory_mb, disk_mb) VALUES (?, 'minute', ?, ?, ?, ?)
     ON CONFLICT (target, step, at) DO UPDATE SET cpu = COALESCE(excluded.cpu, cpu), memory_mb = excluded.memory_mb, disk_mb = COALESCE(excluded.disk_mb, disk_mb)`,
  );
  const box = prev && s.box.cpu.total > prev.box.cpu.total ? round((100 * (s.box.cpu.busy - prev.box.cpu.busy)) / (s.box.cpu.total - prev.box.cpu.total)) : null;
  insert.run(key, minute, box, s.box.memoryMb.used, Math.round(s.box.diskGb.used * 1024));
  for (const [slug, a] of Object.entries(s.apps)) {
    insert.run(slug, minute, cpuPercent(prev?.apps[slug]?.cpuNs, a.cpuNs, prev ? s.at - prev.at : 0, s.box.cpus), a.memoryMb, null);
  }
  if (diskDue) {
    const disk = await agent<{ apps: Record<string, number> }>("metrics.disk", { slugs }, { server }).catch(() => null);
    const update = db().prepare("UPDATE metrics SET disk_mb = ? WHERE target = ? AND step = 'minute' AND at = ?");
    for (const [slug, mb] of Object.entries(disk?.apps ?? {})) update.run(mb, slug, minute);
  }
}

/** Hourly averages for every finished hour that has none yet, then old rows out. */
export function rollUp(now = Date.now()): void {
  const hour = Math.floor(now / HOUR) * HOUR;
  db()
    .prepare(
      `INSERT INTO metrics (target, step, at, cpu, memory_mb, disk_mb)
       SELECT m.target, 'hour', (m.at / ${HOUR}) * ${HOUR} AS h, AVG(m.cpu), AVG(m.memory_mb), MAX(m.disk_mb)
       FROM metrics m
       WHERE m.step = 'minute' AND m.at < ?
         AND NOT EXISTS (SELECT 1 FROM metrics x WHERE x.target = m.target AND x.step = 'hour' AND x.at = (m.at / ${HOUR}) * ${HOUR})
       GROUP BY m.target, h`,
    )
    .run(hour);
  db().prepare("DELETE FROM metrics WHERE step = 'minute' AND at < ?").run(now - DAY);
  db().prepare("DELETE FROM metrics WHERE step = 'hour' AND at < ?").run(now - 7 * DAY);
}

export type Range = "24h" | "7d";

/** Points for a chart: 5-minute averages over a day, or hourly ones over a week. */
export function history(target: string, range: Range, now = Date.now()): Point[] {
  const rows =
    range === "24h"
      ? db()
          .prepare(
            `SELECT (at / 300000) * 300000 AS at, AVG(cpu) AS cpu, AVG(memory_mb) AS memory_mb FROM metrics
             WHERE target = ? AND step = 'minute' AND at >= ? GROUP BY 1 ORDER BY 1`,
          )
          .all(target, now - DAY)
      : db().prepare("SELECT at, cpu, memory_mb FROM metrics WHERE target = ? AND step = 'hour' AND at >= ? ORDER BY at").all(target, now - 7 * DAY);
  return (rows as { at: number; cpu: number | null; memory_mb: number | null }[]).map((r) => ({
    at: r.at,
    cpu: r.cpu === null ? null : round(r.cpu),
    memoryMb: r.memory_mb === null ? null : Math.round(r.memory_mb),
  }));
}

/** The latest disk measurement for a target, in MB. */
export function latestDisk(target: string): number | null {
  const row = db().prepare("SELECT disk_mb FROM metrics WHERE target = ? AND disk_mb IS NOT NULL ORDER BY at DESC LIMIT 1").get(target) as { disk_mb: number } | undefined;
  return row?.disk_mb ?? null;
}

/** Each app's latest minute sample from the last 5 minutes: what the projects list shows. */
export function latestUsage(now = Date.now()): Map<string, Omit<Point, "at">> {
  const rows = db()
    .prepare(
      `SELECT m.target, m.cpu, m.memory_mb FROM metrics m
       JOIN (SELECT target, MAX(at) AS at FROM metrics WHERE step = 'minute' AND target != 'box' AND at >= ? GROUP BY target) l
         ON l.target = m.target AND l.at = m.at
       WHERE m.step = 'minute'`,
    )
    .all(now - 5 * MINUTE) as { target: string; cpu: number | null; memory_mb: number | null }[];
  return new Map(rows.map((r) => [r.target, { cpu: r.cpu === null ? null : round(r.cpu), memoryMb: r.memory_mb === null ? null : Math.round(r.memory_mb) }]));
}

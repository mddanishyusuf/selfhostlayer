import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// db() opens LAYER_DB when first used: a fresh database per test file. The
// fake agent answers metrics.sample and metrics.disk.
process.env.LAYER_DB = join(mkdtempSync(join(tmpdir(), "layer-metrics-")), "panel.db");
process.env.LAYER_FAKE_AGENT = "1";
const { db } = await import("./db");
const { cpuPercent, history, latestDisk, rollUp, sampleMetrics } = await import("./metrics");

const HOUR = 3_600_000;
const insert = (target: string, at: number, cpu: number | null, mem: number | null, disk: number | null = null) =>
  db().prepare("INSERT OR REPLACE INTO metrics (target, step, at, cpu, memory_mb, disk_mb) VALUES (?, 'minute', ?, ?, ?, ?)").run(target, at, cpu, mem, disk);

describe("cpuPercent", () => {
  it("turns cumulative CPU time into a share of the whole server", () => {
    // 30 CPU-seconds in 60 seconds on 2 cores: a quarter of the box.
    expect(cpuPercent(0, 30e9, 60_000, 2)).toBe(25);
    expect(cpuPercent(undefined, 30e9, 60_000, 2)).toBeNull();
    // The app restarted: its counter started over.
    expect(cpuPercent(50e9, 1e9, 60_000, 2)).toBeNull();
  });
});

describe("rollUp and history", () => {
  // Long past: the sampleMetrics test below reads rows the fake agent stamps
  // with the real time, and these rows must never land in its window.
  const now = Date.UTC(2025, 0, 15, 12, 30);
  const hour = Math.floor(now / HOUR) * HOUR;

  it("averages finished hours once, keeps a day of minutes and a week of hours", () => {
    for (let m = 0; m < 60; m++) insert("piqo", hour - HOUR + m * 60_000, m < 30 ? 10 : 20, 200, m === 59 ? 310 : null);
    insert("piqo", hour + 60_000, 50, 250);
    insert("piqo", now - 26 * HOUR, 99, 999);
    rollUp(now);
    const hours = db().prepare("SELECT at, cpu, memory_mb, disk_mb FROM metrics WHERE target = 'piqo' AND step = 'hour' ORDER BY at").all() as { at: number; cpu: number; memory_mb: number; disk_mb: number }[];
    expect(hours.find((h) => h.at === hour - HOUR)).toMatchObject({ cpu: 15, memory_mb: 200, disk_mb: 310 });
    expect(hours.some((h) => h.at === hour)).toBe(false); // the current hour isn't finished
    expect(db().prepare("SELECT COUNT(*) AS n FROM metrics WHERE step = 'minute' AND at = ?").get(now - 26 * HOUR)).toEqual({ n: 0 });

    // A second roll-up doesn't redo the hour from what's left of its minutes.
    db().prepare("DELETE FROM metrics WHERE step = 'minute' AND at < ?").run(hour - HOUR + 30 * 60_000);
    rollUp(now);
    expect(db().prepare("SELECT cpu FROM metrics WHERE target = 'piqo' AND step = 'hour' AND at = ?").get(hour - HOUR)).toEqual({ cpu: 15 });
  });

  it("serves 5-minute points for a day and hourly ones for a week", () => {
    const day = history("piqo", "24h", now);
    expect(day.length).toBeGreaterThan(5);
    expect(day.every((p, i) => i === 0 || p.at > day[i - 1]!.at)).toBe(true);
    expect(history("piqo", "7d", now).map((p) => p.cpu)).toContain(15);
    expect(latestDisk("piqo")).toBe(310);
    expect(history("nobody", "24h", now)).toEqual([]);
  });
});

describe("sampleMetrics", () => {
  it("keeps the disk measurement when a second sample lands in the same minute", async () => {
    const minute = Date.UTC(2026, 9, 30, 15, 0);
    await sampleMetrics(minute + 5_000);
    await sampleMetrics(minute + 50_000);
    // The fake agent stamps its sample with the real time: look in that minute.
    const [a, b] = [Date.now() - 5 * 60_000, Date.now() + 60_000];
    const rows = db().prepare("SELECT memory_mb, disk_mb FROM metrics WHERE target = 'piqo' AND step = 'minute' AND at BETWEEN ? AND ?").all(a, b);
    expect(rows).toEqual([{ memory_mb: 212, disk_mb: 310 }]);
    // Minute rows only: rolling up at the test's time can turn real-time samples into an hour row in the window.
    expect(db().prepare("SELECT memory_mb FROM metrics WHERE target = 'box' AND step = 'minute' AND at BETWEEN ? AND ?").all(a, b)).toEqual([{ memory_mb: 610 }]);
  });
});

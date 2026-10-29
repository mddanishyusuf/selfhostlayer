// Usage samples for the panel's charts. CPU comes as cumulative time
// (systemd's per-unit CPUUsageNSec, /proc/stat for the box): the panel turns
// two samples a minute apart into a percentage. Memory is what's in use now.
import { existsSync, readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import { assertSlug, ValidationError } from "@layer/protocol";
import type { ActionTable, Context, Params } from "../context.ts";
import { BIN } from "../exec.ts";
import { childOf } from "../fsutil.ts";
import { memInfoMb } from "./system.ts";

function assertSlugs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500) throw new ValidationError("slugs", "must be a list of at most 500 apps");
  return value.map((s, i) => assertSlug(s, `slugs[${i}]`));
}

/** `systemctl show` for several units: one block per unit, blank lines between. */
export function parseShowBlocks(stdout: string): Record<string, string>[] {
  return stdout
    .trim()
    .split(/\n\s*\n/)
    .map((block) => Object.fromEntries(block.split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2))));
}

/** Busy and total CPU time of the whole box, in clock ticks since boot. */
export function procStat(text = existsSync("/proc/stat") ? readFileSync("/proc/stat", "utf8") : ""): { busy: number; total: number } {
  const fields = (text.split("\n")[0] ?? "").trim().split(/\s+/);
  if (fields[0] !== "cpu") return { busy: 0, total: 0 };
  const v = fields.slice(1, 9).map(Number);
  const total = v.reduce((a, b) => a + b, 0);
  return { busy: total - (v[3] ?? 0) - (v[4] ?? 0), total };
}

async function metricsSample(params: Params, ctx: Context) {
  const slugs = assertSlugs(params.slugs);
  const apps: Record<string, { cpuNs: number; memoryMb: number }> = {};
  const units = slugs.flatMap((s) => [`app-${s}@blue.service`, `app-${s}@green.service`]);
  if (units.length) {
    const { stdout } = await ctx.exec(BIN.systemctl, ["show", ...units, "-p", "Id", "-p", "CPUUsageNSec", "-p", "MemoryCurrent"], { allowFail: true });
    for (const props of parseShowBlocks(stdout)) {
      const unit = /^app-([a-z0-9-]+)@(?:blue|green)\.service$/.exec(props.Id ?? "");
      if (!unit) continue;
      const app = (apps[unit[1]!] ??= { cpuNs: 0, memoryMb: 0 });
      // "[not set]" for a stopped color: nothing to add.
      const cpu = Number(props.CPUUsageNSec);
      const memory = Number(props.MemoryCurrent);
      if (Number.isFinite(cpu)) app.cpuNs += cpu;
      if (Number.isFinite(memory)) app.memoryMb += memory / 2 ** 20;
    }
  }
  for (const a of Object.values(apps)) a.memoryMb = Math.round(a.memoryMb * 10) / 10;
  const mem = memInfoMb();
  const disk = statfsSync("/");
  const gb = (blocks: number) => Math.round(((blocks * disk.bsize) / 2 ** 30) * 10) / 10;
  return {
    at: Date.now(),
    box: {
      cpu: procStat(),
      cpus: os.availableParallelism(),
      memoryMb: { used: Math.round((mem.MemTotal ?? 0) - (mem.MemAvailable ?? 0)), total: Math.round(mem.MemTotal ?? 0) },
      diskGb: { used: gb(disk.blocks - disk.bavail), total: gb(disk.blocks) },
    },
    apps,
  };
}

/** Disk space each app takes (releases, data, caches), in MB. Slower than a sample: the panel asks every 15 minutes. */
async function metricsDisk(params: Params, ctx: Context) {
  const apps: Record<string, number> = {};
  for (const slug of assertSlugs(params.slugs)) {
    const dir = childOf(ctx.paths.appsRoot, slug);
    if (!existsSync(dir)) continue;
    const { stdout } = await ctx.exec(BIN.du, ["-s", "-B1", dir], { allowFail: true, timeoutMs: 120_000 });
    const bytes = Number(stdout.split(/\s/)[0]);
    if (Number.isFinite(bytes)) apps[slug] = Math.round(bytes / 2 ** 20);
  }
  return { apps };
}

export const metricsActions: ActionTable = {
  "metrics.sample": { mutates: false, run: metricsSample },
  "metrics.disk": { mutates: false, run: metricsDisk },
};

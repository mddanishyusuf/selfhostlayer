import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import os from "node:os";
import { AGENT_VERSION } from "../config.ts";
import type { ActionTable, Context } from "../context.ts";
import { BIN } from "../exec.ts";

function osRelease(): Record<string, string> {
  if (!existsSync("/etc/os-release")) return {};
  const fields: Record<string, string> = {};
  for (const line of readFileSync("/etc/os-release", "utf8").split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match) fields[match[1]!] = match[2]!.replace(/^"|"$/g, "");
  }
  return fields;
}

/** MemAvailable is what's really free (it counts reclaimable cache); os.freemem() isn't. */
export function memInfoMb(): Record<string, number> {
  if (!existsSync("/proc/meminfo")) {
    return { MemTotal: os.totalmem() / 2 ** 20, MemAvailable: os.freemem() / 2 ** 20 };
  }
  const values: Record<string, number> = {};
  for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
    const match = /^(\w+):\s+(\d+) kB$/.exec(line);
    if (match) values[match[1]!] = Number(match[2]) / 1024;
  }
  return values;
}

async function systemInfo(_params: unknown, ctx: Context) {
  const release = osRelease();
  const mem = memInfoMb();
  const disk = statfsSync("/");
  const caddy = await ctx.exec(BIN.systemctl, ["is-active", "caddy"], { allowFail: true });
  const nodeVersions = existsSync(ctx.paths.nodeRoot)
    ? readdirSync(ctx.paths.nodeRoot).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort()
    : [];
  const gb = (blocks: number) => Math.round(((blocks * disk.bsize) / 2 ** 30) * 10) / 10;

  return {
    agentVersion: AGENT_VERSION,
    hostname: os.hostname(),
    os: { id: release.ID ?? os.platform(), version: release.VERSION_ID ?? "", name: release.PRETTY_NAME ?? "" },
    kernel: os.release(),
    arch: os.arch(),
    cpus: os.availableParallelism(),
    loadavg: os.loadavg().map((l) => Math.round(l * 100) / 100),
    memoryMb: { total: Math.round(mem.MemTotal ?? 0), available: Math.round(mem.MemAvailable ?? 0) },
    swapMb: { total: Math.round(mem.SwapTotal ?? 0), free: Math.round(mem.SwapFree ?? 0) },
    diskGb: { total: gb(disk.blocks), free: gb(disk.bavail) },
    uptimeSec: Math.round(os.uptime()),
    nodeVersions,
    caddy: caddy.stdout.trim() || "unknown",
  };
}

export const systemActions: ActionTable = {
  "system.info": { mutates: false, run: systemInfo },
};

// The monthly cron job's work: DB-IP's newest "IP to Country Lite" (this
// month's, or last month's early in the month) as data/geo.bin, which the
// server picks up within an hour. The copy in the release is the fallback.
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { buildGeo } from "./geo-build.ts";

export const dbipUrl = (month: string) => `https://download.db-ip.com/free/dbip-country-lite-${month}.csv.gz`;

/** This month and the one before, as DB-IP names them (2026-10). */
export function recentMonths(now = Date.now()): [string, string] {
  const d = new Date(now);
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return [d.toISOString().slice(0, 7), prev.toISOString().slice(0, 7)];
}

export async function fetchDbip(now = Date.now()): Promise<{ csv: string; source: string }> {
  const errors: string[] = [];
  for (const month of recentMonths(now)) {
    try {
      const res = await fetch(dbipUrl(month), { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { csv: gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8"), source: `dbip-country-lite-${month}` };
    } catch (err) {
      errors.push(`${month}: ${(err as Error).message}`);
    }
  }
  throw new Error(`couldn't download DB-IP's country list (${errors.join("; ")})`);
}

export async function updateGeo(dataDir: string): Promise<{ source: string; bytes: number }> {
  const { csv, source } = await fetchDbip();
  const bin = buildGeo(csv, source);
  const path = join(dataDir, "geo.bin");
  writeFileSync(`${path}.tmp`, bin);
  renameSync(`${path}.tmp`, path);
  return { source, bytes: bin.length };
}

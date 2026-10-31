// What a catalog app's build (npm run build) shares: bundling with esbuild,
// so nothing is installed on the server, and DB-IP's country list as geo.bin.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";
import { buildGeo } from "./geo-build.ts";
import { dbipUrl, recentMonths } from "./geo-update.ts";

/**
 * A fresh dist/ with each entry bundled (name → source), the version defined
 * as `define` names it, and a package.json so Node reads the bundles as ES
 * modules. Only Node's own modules may stay as imports.
 */
export async function bundleApp(o: { dist: string; entries: Record<string, string>; define?: Record<string, string> }): Promise<void> {
  rmSync(o.dist, { recursive: true, force: true });
  mkdirSync(o.dist);
  await build({
    entryPoints: o.entries,
    outdir: o.dist,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    define: Object.fromEntries(Object.entries(o.define ?? {}).map(([k, v]) => [k, JSON.stringify(v)])),
    legalComments: "none",
    logLevel: "warning",
  });
  for (const name of Object.keys(o.entries)) {
    const file = `${name}.js`;
    const outside = [...readFileSync(join(o.dist, file), "utf8").matchAll(/from\s*"([^"]+)"/g)].map((m) => m[1]!).filter((m) => !m.startsWith("node:"));
    if (outside.length) throw new Error(`${file} imports ${[...new Set(outside)].join(", ")}`);
  }
  writeFileSync(join(o.dist, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
}

/**
 * dist/geo.bin from DB-IP's list for this month, downloaded once into
 * dist/cache at the repo's root (GEO_CSV=<file.csv or .csv.gz> uses a local
 * copy instead), and its attribution in dist/NOTICE. Returns the list's name.
 */
export async function writeCountryList(dist: string): Promise<{ source: string; bytes: number }> {
  let csv: string | null = null;
  let source = "";
  const local = process.env.GEO_CSV ?? process.env.LINKS_GEO_CSV;
  if (local) {
    const raw = readFileSync(local);
    csv = (local.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
    source = basename(local).replace(/\.csv(\.gz)?$/, "");
  } else {
    const cache = join(import.meta.dirname, "..", "..", "dist", "cache");
    mkdirSync(cache, { recursive: true });
    for (const month of recentMonths()) {
      const file = join(cache, `dbip-country-lite-${month}.csv.gz`);
      if (!existsSync(file)) {
        const res = await fetch(dbipUrl(month), { signal: AbortSignal.timeout(120_000) }).catch(() => null);
        if (!res?.ok) continue;
        writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      }
      csv = gunzipSync(readFileSync(file)).toString("utf8");
      source = `dbip-country-lite-${month}`;
      break;
    }
  }
  if (csv === null) throw new Error("couldn't download DB-IP's country list: set GEO_CSV to a local copy");
  const geo = buildGeo(csv, source);
  writeFileSync(join(dist, "geo.bin"), geo);
  writeFileSync(join(dist, "NOTICE"), `Country data: ${source}, "IP to Country Lite" by DB-IP (https://db-ip.com), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).\n`);
  return { source, bytes: geo.length };
}

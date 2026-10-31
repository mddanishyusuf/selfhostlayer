// npm run build: Links' dist/, which scripts/build-catalog.ts packs.
//   server.js, cron.js  bundled by esbuild, so nothing is installed on the server
//   geo.bin             countries, from DB-IP's list for this month, downloaded once
//                       into dist/cache at the repo's root (LINKS_GEO_CSV=<file.csv or
//                       .csv.gz> uses a local copy instead)
//   package.json        so Node reads the bundles as ES modules
//   NOTICE              DB-IP's attribution (CC BY 4.0)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";
import { buildGeo } from "./src/geo-build.ts";
import { dbipUrl, recentMonths } from "./src/geo-update.ts";

const here = import.meta.dirname;
const dist = join(here, "dist");
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as { version: string };

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
await build({
  entryPoints: { server: join(here, "src/server.ts"), cron: join(here, "src/cron.ts") },
  outdir: dist,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  define: { LINKS_VERSION: JSON.stringify(version) },
  legalComments: "none",
  logLevel: "warning",
});
// Only Node's own modules may stay as imports: everything else is bundled.
for (const file of ["server.js", "cron.js"]) {
  const outside = [...readFileSync(join(dist, file), "utf8").matchAll(/from\s*"([^"]+)"/g)].map((m) => m[1]!).filter((m) => !m.startsWith("node:"));
  if (outside.length) throw new Error(`${file} imports ${[...new Set(outside)].join(", ")}`);
}
writeFileSync(join(dist, "package.json"), `${JSON.stringify({ type: "module" })}\n`);

async function countryList(): Promise<{ csv: string; source: string }> {
  const local = process.env.LINKS_GEO_CSV;
  if (local) {
    const raw = readFileSync(local);
    return { csv: (local.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8"), source: basename(local).replace(/\.csv(\.gz)?$/, "") };
  }
  const cache = join(here, "..", "..", "dist", "cache");
  mkdirSync(cache, { recursive: true });
  for (const month of recentMonths()) {
    const file = join(cache, `dbip-country-lite-${month}.csv.gz`);
    if (!existsSync(file)) {
      const res = await fetch(dbipUrl(month), { signal: AbortSignal.timeout(120_000) }).catch(() => null);
      if (!res?.ok) continue;
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    return { csv: gunzipSync(readFileSync(file)).toString("utf8"), source: `dbip-country-lite-${month}` };
  }
  throw new Error("couldn't download DB-IP's country list: set LINKS_GEO_CSV to a local copy");
}

const { csv, source } = await countryList();
const geo = buildGeo(csv, source);
writeFileSync(join(dist, "geo.bin"), geo);
writeFileSync(join(dist, "NOTICE"), `Country data: ${source}, "IP to Country Lite" by DB-IP (https://db-ip.com), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).\n`);
console.error(`built Links ${version}: server.js, cron.js, geo.bin (${source}, ${Math.round(geo.length / 1024)} KB)`);

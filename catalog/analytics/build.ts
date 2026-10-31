// npm run build: Analytics' dist/, which scripts/build-catalog.ts packs.
//   server.js, cron.js  bundled by esbuild, so nothing is installed on the server
//   geo.bin, NOTICE     countries from DB-IP's list for this month (catalog/lib/build.ts)
//   package.json        so Node reads the bundles as ES modules
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bundleApp, writeCountryList } from "../lib/build.ts";

const here = import.meta.dirname;
const dist = join(here, "dist");
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as { version: string };

await bundleApp({ dist, entries: { server: join(here, "src/server.ts"), cron: join(here, "src/cron.ts") }, define: { ANALYTICS_VERSION: version } });
const geo = await writeCountryList(dist);
console.error(`built Analytics ${version}: server.js, cron.js, geo.bin (${geo.source}, ${Math.round(geo.bytes / 1024)} KB)`);

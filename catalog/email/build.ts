// npm run build: Email's dist/, which scripts/build-catalog.ts packs.
//   server.js, cron.js  bundled by esbuild, so nothing is installed on the server
//   package.json        so Node reads the bundles as ES modules
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bundleApp } from "../lib/build.ts";

const here = import.meta.dirname;
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as { version: string };

await bundleApp({ dist: join(here, "dist"), entries: { server: join(here, "src/server.ts"), cron: join(here, "src/cron.ts") }, define: { EMAIL_VERSION: version } });
console.error(`built Email ${version}: server.js, cron.js`);

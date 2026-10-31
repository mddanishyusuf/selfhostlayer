// node server.js: Analytics on 127.0.0.1:$PORT, its data in $DATA_DIR (set by
// Self Host Layer). Stopping writes the events still queued.
import { createApp } from "./app.ts";

declare const ANALYTICS_VERSION: string | undefined;
const version = typeof ANALYTICS_VERSION === "string" ? ANALYTICS_VERSION : "dev";

const token = process.env.ANALYTICS_ADMIN_TOKEN ?? "";
if (token.length < 32) {
  console.error("ANALYTICS_ADMIN_TOKEN must be set to at least 32 characters (Self Host Layer makes one at install)");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const app = createApp({ dataDir: process.env.DATA_DIR ?? "data", token, releaseDir: import.meta.dirname, version });
app.server.listen(port, host, () => {
  const geo = app.geo();
  console.log(`Analytics ${version} on ${host}:${port}: ${app.sites.list().length} sites, ${geo ? `countries from ${geo.source}` : "no country list"}`);
});

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void app.close().then(() => process.exit(0));
  });
}

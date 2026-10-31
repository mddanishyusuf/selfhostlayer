// node server.js: Email on 127.0.0.1:$PORT, its data in $DATA_DIR (set by Self
// Host Layer). Stopping lets the worker finish what it was sending.
import { createApp } from "./app.ts";

declare const EMAIL_VERSION: string | undefined;
const version = typeof EMAIL_VERSION === "string" ? EMAIL_VERSION : "dev";

const token = process.env.EMAIL_ADMIN_TOKEN ?? "";
const secret = process.env.EMAIL_SECRET ?? "";
if (token.length < 32 || secret.length < 32) {
  console.error("EMAIL_ADMIN_TOKEN and EMAIL_SECRET must be set to at least 32 characters (Self Host Layer makes them at install)");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const app = createApp({ dataDir: process.env.DATA_DIR ?? "data", token, secret, version });
app.server.listen(port, host, () => console.log(`Email ${version} on ${host}:${port}: ${app.brands.list().length} brands, links on ${app.publicUrl()}`));

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void app.close().then(() => process.exit(0));
  });
}

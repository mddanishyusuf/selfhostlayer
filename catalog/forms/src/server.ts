// node server.js: Forms on 127.0.0.1:$PORT, its data in $DATA_DIR (set by
// Self Host Layer).
import { createApp } from "./app.ts";

declare const FORMS_VERSION: string | undefined;
const version = typeof FORMS_VERSION === "string" ? FORMS_VERSION : "dev";

const token = process.env.FORMS_ADMIN_TOKEN ?? "";
const secret = process.env.FORMS_SECRET ?? "";
if (token.length < 32 || secret.length < 32) {
  console.error("FORMS_ADMIN_TOKEN and FORMS_SECRET must be set to at least 32 characters (Self Host Layer makes them at install)");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const app = createApp({ dataDir: process.env.DATA_DIR ?? "data", token, secret, releaseDir: import.meta.dirname, version });
app.server.listen(port, host, () => console.log(`Forms ${version} on ${host}:${port}: ${app.forms.list().length} forms`));

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void app.close().then(() => process.exit(0));
  });
}

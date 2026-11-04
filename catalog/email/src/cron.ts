// node cron.js prune|geo: Email's cron jobs, run by Self Host Layer as the
// app's user in its release folder (layer.yaml says when).
//   prune  bodies and messages past the keep window, and Shield's old log (daily)
//   geo    the newest country list from DB-IP (monthly)
import { join } from "node:path";
import { updateGeo } from "../../lib/geo-update.ts";
import { openDb } from "./db.ts";
import { prune } from "./prune.ts";

const dataDir = process.env.DATA_DIR ?? "data";
const task = process.argv[2];
if (task === "prune") {
  const db = openDb(join(dataDir, "email.db"));
  const r = prune(db);
  db.close();
  console.log(`Deleted the bodies of ${r.bodies} emails, and ${r.messages} old messages.`);
} else if (task === "geo") {
  const r = await updateGeo(dataDir);
  console.log(`Countries now come from ${r.source} (${Math.round(r.bytes / 1024)} KB).`);
} else {
  console.error("usage: node cron.js prune|geo");
  process.exit(2);
}

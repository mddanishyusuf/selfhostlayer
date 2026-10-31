// node cron.js prune|geo: Analytics' cron jobs, run by Self Host Layer as the
// app's user in its release folder (layer.yaml says when).
//   prune  events and visits past the keep window are deleted (daily)
//   geo    the newest country list from DB-IP (monthly)
import { join } from "node:path";
import { updateGeo } from "../../lib/geo-update.ts";
import { readSettings } from "./admin.ts";
import { openDb } from "./db.ts";
import { prune } from "./stats.ts";

const dataDir = process.env.DATA_DIR ?? "data";
const task = process.argv[2];

if (task === "prune") {
  const db = openDb(join(dataDir, "analytics.db"));
  const { keepDays } = readSettings(db);
  const r = prune(db, keepDays);
  db.close();
  console.log(`Deleted ${r.events} events and ${r.visits} visits older than ${keepDays} days.`);
} else if (task === "geo") {
  const r = await updateGeo(dataDir);
  console.log(`Countries now come from ${r.source} (${Math.round(r.bytes / 1024)} KB).`);
} else {
  console.error("usage: node cron.js prune|geo");
  process.exit(2);
}

// node cron.js rollup|geo: Links' cron jobs, run by Self Host Layer as the
// app's user in its release folder (layer.yaml says when).
//   rollup  raw clicks past the keep window become daily totals (daily)
//   geo     the newest country list from DB-IP (monthly)
import { join } from "node:path";
import { openDb } from "./db.ts";
import { updateGeo } from "./geo-update.ts";
import { readSettings } from "./settings.ts";
import { rollup } from "./stats.ts";

const dataDir = process.env.DATA_DIR ?? "data";
const task = process.argv[2];

if (task === "rollup") {
  const db = openDb(join(dataDir, "links.db"));
  const { keepDays } = readSettings(db);
  const r = rollup(db, keepDays);
  db.close();
  console.log(r.days ? `Rolled ${r.clicks} clicks from ${r.days} day(s) older than ${keepDays} days into daily totals.` : `No clicks older than ${keepDays} days.`);
} else if (task === "geo") {
  const r = await updateGeo(dataDir);
  console.log(`Countries now come from ${r.source} (${Math.round(r.bytes / 1024)} KB).`);
} else {
  console.error("usage: node cron.js rollup|geo");
  process.exit(2);
}

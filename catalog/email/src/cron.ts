// node cron.js prune: Email's cron job, run by Self Host Layer as the app's
// user in its release folder (layer.yaml says when).
import { join } from "node:path";
import { openDb } from "./db.ts";
import { prune } from "./prune.ts";

const task = process.argv[2];
if (task === "prune") {
  const db = openDb(join(process.env.DATA_DIR ?? "data", "email.db"));
  const r = prune(db);
  db.close();
  console.log(`Deleted the bodies of ${r.bodies} emails, and ${r.messages} old messages.`);
} else {
  console.error("usage: node cron.js prune");
  process.exit(2);
}

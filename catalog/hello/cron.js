// node cron.js tidy: forgets visits older than 30 days.
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

if (process.argv[2] !== "tidy") {
  console.error("usage: node cron.js tidy");
  process.exit(2);
}
const db = new DatabaseSync(join(process.env.DATA_DIR ?? "data", "hello.db"));
db.exec("CREATE TABLE IF NOT EXISTS visits (at INTEGER NOT NULL)");
const { changes } = db.prepare("DELETE FROM visits WHERE at < ?").run(Date.now() - 30 * 86_400_000);
console.log(`Forgot ${changes} old visits.`);

// The catalog's test app: answers every request with a greeting and the
// number of visits so far, kept in SQLite in the app's data folder.
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(join(process.env.DATA_DIR ?? "data", "hello.db"));
db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS visits (at INTEGER NOT NULL)");
const add = db.prepare("INSERT INTO visits (at) VALUES (?)");
const count = db.prepare("SELECT count(*) AS n FROM visits");
const greeting = process.env.HELLO_GREETING || "Hello";

createServer((req, res) => {
  if (req.url === "/healthz") return res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
  add.run(Date.now());
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(`${greeting} from the Self Host Layer catalog. Visits: ${count.get().n}\n`);
}).listen(Number(process.env.PORT ?? 3000), "127.0.0.1");

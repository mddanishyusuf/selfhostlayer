// A catalog app's SQLite database: WAL mode, migrated at start from its
// numbered list. Each migration runs once, in a transaction, and is recorded
// in the migrations table. A database migrated by a newer version of the app
// is refused, so an older version never runs on a schema it doesn't know.
import { DatabaseSync } from "node:sqlite";

export class NewerDatabaseError extends Error {}

export function openMigrated(path: string, migrations: string[], name: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set((db.prepare("SELECT id FROM migrations").all() as { id: number }[]).map((r) => r.id));
  const newest = Math.max(0, ...done);
  if (newest > migrations.length) {
    db.close();
    throw new NewerDatabaseError(`${name} was migrated by a newer version (migration ${newest}, this one knows ${migrations.length}): restore the backup from before the update, or update again`);
  }
  migrations.forEach((sql, i) => {
    const id = i + 1;
    if (done.has(id)) return;
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)").run(id, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  });
  return db;
}

export function getSetting(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

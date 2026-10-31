// Links' database, data/links.db: SQLite in WAL mode, migrated at start from
// the numbered list below. Each migration runs once, in a transaction, and is
// recorded in the migrations table. A database migrated by a newer Links is
// refused, so an older version never runs on a schema it doesn't know.
import { DatabaseSync } from "node:sqlite";

export const MIGRATIONS = [
  // 1: links, raw clicks, daily totals for clicks past the keep window, API tokens, settings.
  `CREATE TABLE links (
     id INTEGER PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     target TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     tags TEXT NOT NULL DEFAULT '[]',
     redirect INTEGER NOT NULL DEFAULT 302,
     pass_query INTEGER NOT NULL DEFAULT 1,
     password_hash TEXT,
     expires_at INTEGER,
     disabled INTEGER NOT NULL DEFAULT 0,
     clicks INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE clicks (
     link_id INTEGER NOT NULL,
     at INTEGER NOT NULL,
     referrer TEXT,
     country TEXT,
     device TEXT NOT NULL,
     browser TEXT NOT NULL,
     os TEXT NOT NULL,
     bot INTEGER NOT NULL DEFAULT 0,
     visitor TEXT NOT NULL
   );
   CREATE INDEX clicks_at ON clicks (at);
   CREATE INDEX clicks_link_at ON clicks (link_id, at);
   CREATE TABLE clicks_daily (
     link_id INTEGER NOT NULL,
     day TEXT NOT NULL,
     clicks INTEGER NOT NULL,
     visitors INTEGER NOT NULL,
     bots INTEGER NOT NULL,
     breakdown TEXT NOT NULL,
     PRIMARY KEY (link_id, day)
   );
   CREATE TABLE tokens (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,
     prefix TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER
   );
   CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
];

export class NewerDatabaseError extends Error {}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set((db.prepare("SELECT id FROM migrations").all() as { id: number }[]).map((r) => r.id));
  const newest = Math.max(0, ...done);
  if (newest > MIGRATIONS.length) {
    db.close();
    throw new NewerDatabaseError(`links.db was migrated by a newer Links (migration ${newest}, this version knows ${MIGRATIONS.length}): restore the backup from before the update, or update again`);
  }
  MIGRATIONS.forEach((sql, i) => {
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

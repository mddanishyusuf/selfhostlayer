// Links' database, data/links.db: SQLite in WAL mode, migrated at start from
// the numbered list below (catalog/lib/db.ts runs them, and refuses a database
// from a newer Links).
import type { DatabaseSync } from "node:sqlite";
import { getSetting, NewerDatabaseError, openMigrated, setSetting } from "../../lib/db.ts";

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

/** links.db, migrated. */
export function openDb(path: string): DatabaseSync {
  return openMigrated(path, MIGRATIONS, "links.db");
}

export { getSetting, NewerDatabaseError, setSetting };

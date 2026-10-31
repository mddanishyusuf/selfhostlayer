// Analytics' database, data/analytics.db: SQLite in WAL mode, migrated at
// start from the numbered list below (catalog/lib/db.ts runs them, and refuses
// a database from a newer Analytics).
import type { DatabaseSync } from "node:sqlite";
import { getSetting, NewerDatabaseError, openMigrated, setSetting } from "../../lib/db.ts";

export const MIGRATIONS = [
  // 1: sites, events (pageviews and custom events), visits built as events arrive, settings.
  `CREATE TABLE sites (
     id INTEGER PRIMARY KEY,
     domain TEXT NOT NULL UNIQUE,
     subdomains INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE events (
     site_id INTEGER NOT NULL,
     at INTEGER NOT NULL,
     name TEXT NOT NULL,
     path TEXT NOT NULL,
     visitor TEXT NOT NULL,
     session TEXT NOT NULL,
     props TEXT
   );
   CREATE INDEX events_site_at ON events (site_id, at);
   CREATE INDEX events_session ON events (session);
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     site_id INTEGER NOT NULL,
     visitor TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     ended_at INTEGER NOT NULL,
     pageviews INTEGER NOT NULL,
     events INTEGER NOT NULL,
     entry TEXT NOT NULL,
     exit TEXT NOT NULL,
     referrer TEXT,
     utm_source TEXT,
     utm_medium TEXT,
     utm_campaign TEXT,
     country TEXT,
     device TEXT NOT NULL,
     browser TEXT NOT NULL,
     os TEXT NOT NULL,
     screen TEXT
   );
   CREATE INDEX sessions_site_started ON sessions (site_id, started_at);
   CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
];

/** analytics.db, migrated. */
export function openDb(path: string): DatabaseSync {
  return openMigrated(path, MIGRATIONS, "analytics.db");
}

export { getSetting, NewerDatabaseError, setSetting };

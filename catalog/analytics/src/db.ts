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
  // 2: goals; revenue pulled from payment providers (their keys, encrypted, and
  // the payments, each credited to a visit when it can be); and each paying
  // customer's first visit, which their later payments (renewals) go to.
  `CREATE TABLE goals (
     id INTEGER PRIMARY KEY,
     site_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('page', 'event')),
     value TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE revenue_sources (
     site_id INTEGER NOT NULL,
     provider TEXT NOT NULL CHECK (provider IN ('stripe', 'polar', 'dodo')),
     api_key TEXT NOT NULL,
     key_hint TEXT NOT NULL,
     mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
     synced_at INTEGER,
     sync_error TEXT,
     error_at INTEGER,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (site_id, provider)
   );
   CREATE TABLE payments (
     site_id INTEGER NOT NULL,
     provider TEXT NOT NULL,
     external_id TEXT NOT NULL,
     at INTEGER NOT NULL,
     amount INTEGER NOT NULL,
     currency TEXT NOT NULL,
     customer TEXT,
     visit TEXT,
     renewal INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (site_id, provider, external_id)
   );
   CREATE INDEX payments_site_at ON payments (site_id, at);
   CREATE INDEX payments_visit ON payments (visit);
   CREATE TABLE customers (
     site_id INTEGER NOT NULL,
     provider TEXT NOT NULL,
     customer TEXT NOT NULL,
     visit TEXT NOT NULL,
     at INTEGER NOT NULL,
     PRIMARY KEY (site_id, provider, customer)
   );`,
  // 3: Paddle, Creem and Lemon Squeezy as providers (the last two send webhooks,
  // and their source keeps the webhook's signing secret where others keep a key).
  `CREATE TABLE revenue_sources_3 (
     site_id INTEGER NOT NULL,
     provider TEXT NOT NULL CHECK (provider IN ('stripe', 'polar', 'paddle', 'dodo', 'creem', 'lemonsqueezy')),
     api_key TEXT NOT NULL,
     key_hint TEXT NOT NULL,
     mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
     synced_at INTEGER,
     sync_error TEXT,
     error_at INTEGER,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (site_id, provider)
   );
   INSERT INTO revenue_sources_3 SELECT site_id, provider, api_key, key_hint, mode, synced_at, sync_error, error_at, created_at FROM revenue_sources;
   DROP TABLE revenue_sources;
   ALTER TABLE revenue_sources_3 RENAME TO revenue_sources;`,
];

/** analytics.db, migrated. */
export function openDb(path: string): DatabaseSync {
  return openMigrated(path, MIGRATIONS, "analytics.db");
}

export { getSetting, NewerDatabaseError, setSetting };

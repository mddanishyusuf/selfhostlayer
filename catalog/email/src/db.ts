// Email's database, data/email.db: SQLite in WAL mode, migrated at start from
// the numbered list below (catalog/lib/db.ts runs them, and refuses a database
// from a newer Email).
import type { DatabaseSync } from "node:sqlite";
import { getSetting, NewerDatabaseError, openMigrated, setSetting } from "../../lib/db.ts";

export const MIGRATIONS = [
  // 1: brands and their sending domains; contacts, lists and suppressions;
  // templates, campaigns and automations; the messages queue (every email
  // sent, of every kind) with its events; API keys.
  `CREATE TABLE brands (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     from_name TEXT NOT NULL DEFAULT '',
     from_email TEXT NOT NULL DEFAULT '',
     reply_to TEXT NOT NULL DEFAULT '',
     address TEXT NOT NULL DEFAULT '',
     website TEXT NOT NULL DEFAULT '',
     provider TEXT NOT NULL DEFAULT 'none' CHECK (provider IN ('none', 'smtp', 'ses')),
     provider_config TEXT NOT NULL DEFAULT '{}',
     provider_secret TEXT,
     rate REAL NOT NULL DEFAULT 5,
     track_opens INTEGER NOT NULL DEFAULT 1,
     track_clicks INTEGER NOT NULL DEFAULT 1,
     ses_events TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE domains (
     id INTEGER PRIMARY KEY,
     brand_id INTEGER NOT NULL,
     domain TEXT NOT NULL,
     selector TEXT NOT NULL,
     dkim_private TEXT,
     dkim_public TEXT,
     ses_tokens TEXT,
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed')),
     checks TEXT NOT NULL DEFAULT '{}',
     checked_at INTEGER,
     verified_at INTEGER,
     created_at INTEGER NOT NULL,
     UNIQUE (brand_id, domain)
   );
   CREATE TABLE contacts (
     id INTEGER PRIMARY KEY,
     brand_id INTEGER NOT NULL,
     email TEXT NOT NULL COLLATE NOCASE,
     name TEXT NOT NULL DEFAULT '',
     fields TEXT NOT NULL DEFAULT '{}',
     status TEXT NOT NULL DEFAULT 'subscribed' CHECK (status IN ('subscribed', 'unconfirmed', 'unsubscribed', 'bounced', 'complained')),
     source TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     unsubscribed_at INTEGER,
     UNIQUE (brand_id, email)
   );
   CREATE INDEX contacts_brand_status ON contacts (brand_id, status);
   CREATE TABLE lists (
     id INTEGER PRIMARY KEY,
     brand_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     public_key TEXT NOT NULL UNIQUE,
     double_opt_in INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE list_members (
     list_id INTEGER NOT NULL,
     contact_id INTEGER NOT NULL,
     added_at INTEGER NOT NULL,
     PRIMARY KEY (list_id, contact_id)
   );
   CREATE INDEX list_members_contact ON list_members (contact_id);
   CREATE TABLE suppressions (
     brand_id INTEGER NOT NULL,
     email TEXT NOT NULL COLLATE NOCASE,
     reason TEXT NOT NULL CHECK (reason IN ('bounce', 'complaint', 'manual')),
     detail TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     PRIMARY KEY (brand_id, email)
   );
   CREATE TABLE templates (
     id INTEGER PRIMARY KEY,
     brand_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     subject TEXT NOT NULL DEFAULT '',
     html TEXT NOT NULL DEFAULT '',
     text TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL DEFAULT '',
     format TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'html')),
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE campaigns (
     id INTEGER PRIMARY KEY,
     brand_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     subject TEXT NOT NULL DEFAULT '',
     preheader TEXT NOT NULL DEFAULT '',
     from_name TEXT NOT NULL DEFAULT '',
     from_email TEXT NOT NULL DEFAULT '',
     reply_to TEXT NOT NULL DEFAULT '',
     html TEXT NOT NULL DEFAULT '',
     text TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL DEFAULT '',
     format TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'html')),
     lists TEXT NOT NULL DEFAULT '[]',
     exclude_lists TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'paused', 'sent', 'cancelled')),
     paused_reason TEXT,
     scheduled_at INTEGER,
     started_at INTEGER,
     finished_at INTEGER,
     recipients INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE messages (
     id TEXT PRIMARY KEY,
     brand_id INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('campaign', 'transactional', 'automation', 'test', 'confirm')),
     campaign_id INTEGER,
     automation_id INTEGER,
     contact_id INTEGER,
     to_email TEXT NOT NULL,
     from_email TEXT NOT NULL,
     subject TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'failed', 'bounced', 'complained', 'cancelled')),
     priority INTEGER NOT NULL DEFAULT 0,
     send_at INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     claimed_until INTEGER,
     provider_id TEXT,
     error TEXT,
     tags TEXT,
     created_at INTEGER NOT NULL,
     sent_at INTEGER,
     opened_at INTEGER,
     opens INTEGER NOT NULL DEFAULT 0,
     clicked_at INTEGER,
     clicks INTEGER NOT NULL DEFAULT 0,
     unsubscribed_at INTEGER
   );
   CREATE INDEX messages_queue ON messages (status, send_at);
   CREATE INDEX messages_campaign ON messages (campaign_id, status);
   CREATE INDEX messages_brand_created ON messages (brand_id, created_at);
   CREATE INDEX messages_contact ON messages (contact_id);
   CREATE INDEX messages_provider ON messages (provider_id);
   CREATE TABLE message_bodies (
     message_id TEXT PRIMARY KEY,
     payload TEXT NOT NULL
   );
   CREATE TABLE events (
     message_id TEXT NOT NULL,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL,
     detail TEXT
   );
   CREATE INDEX events_message ON events (message_id, at);
   CREATE TABLE automations (
     id INTEGER PRIMARY KEY,
     brand_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     trigger TEXT NOT NULL CHECK (trigger IN ('list', 'event')),
     trigger_value TEXT NOT NULL DEFAULT '',
     steps TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE automation_runs (
     id INTEGER PRIMARY KEY,
     automation_id INTEGER NOT NULL,
     contact_id INTEGER NOT NULL,
     step INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'exited', 'failed')),
     next_at INTEGER NOT NULL,
     data TEXT,
     error TEXT,
     started_at INTEGER NOT NULL,
     finished_at INTEGER,
     claimed_until INTEGER
   );
   CREATE INDEX automation_runs_due ON automation_runs (status, next_at);
   CREATE INDEX automation_runs_automation ON automation_runs (automation_id, contact_id);
   CREATE TABLE api_keys (
     id INTEGER PRIMARY KEY,
     brand_id INTEGER NOT NULL,
     name TEXT NOT NULL,
     key_hash TEXT NOT NULL UNIQUE,
     prefix TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER
   );
   CREATE TABLE idempotency (
     key_id INTEGER NOT NULL,
     key TEXT NOT NULL,
     response TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (key_id, key)
   );
   CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
];

/** email.db, migrated. */
export function openDb(path: string): DatabaseSync {
  return openMigrated(path, MIGRATIONS, "email.db");
}

export { getSetting, NewerDatabaseError, setSetting };

/** A transaction: committed when `run` returns, rolled back when it throws. */
export function tx<T>(db: DatabaseSync, run: () => T): T {
  db.exec("BEGIN");
  try {
    const out = run();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

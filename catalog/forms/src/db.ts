// Forms' database, data/forms.db: SQLite in WAL mode, migrated at start from
// the numbered list below (catalog/lib/db.ts runs them, and refuses a database
// from a newer Forms). Uploaded files live beside it, in data/uploads/.
import type { DatabaseSync } from "node:sqlite";
import { getSetting, NewerDatabaseError, openMigrated, setSetting } from "../../lib/db.ts";

export const MIGRATIONS = [
  // 1: forms (their fields as JSON), responses, the files sent with them, and
  // notifications to deliver (webhooks, emails).
  `CREATE TABLE forms (
     id INTEGER PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     title TEXT NOT NULL,
     schema TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
     close_at INTEGER,
     max_responses INTEGER,
     closed_message TEXT NOT NULL DEFAULT '',
     notify TEXT NOT NULL DEFAULT '{}',
     views INTEGER NOT NULL DEFAULT 0,
     starts INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE responses (
     id INTEGER PRIMARY KEY,
     form_id INTEGER NOT NULL,
     answers TEXT NOT NULL,
     meta TEXT NOT NULL DEFAULT '{}',
     created_at INTEGER NOT NULL
   );
   CREATE INDEX responses_form ON responses (form_id, created_at);
   CREATE TABLE files (
     id TEXT PRIMARY KEY,
     response_id INTEGER NOT NULL,
     form_id INTEGER NOT NULL,
     field_id TEXT NOT NULL,
     name TEXT NOT NULL,
     type TEXT NOT NULL,
     size INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX files_response ON files (response_id);
   CREATE TABLE deliveries (
     id INTEGER PRIMARY KEY,
     response_id INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('webhook', 'email', 'receipt')),
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
     attempts INTEGER NOT NULL DEFAULT 0,
     next_at INTEGER NOT NULL,
     error TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX deliveries_due ON deliveries (status, next_at);
   CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
];

/** forms.db, migrated. */
export function openDb(path: string): DatabaseSync {
  return openMigrated(path, MIGRATIONS, "forms.db");
}

export { getSetting, NewerDatabaseError, setSetting };

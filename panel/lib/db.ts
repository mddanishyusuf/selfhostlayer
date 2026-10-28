import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config";

const MIGRATIONS = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     totp_secret_enc TEXT NOT NULL,
     totp_last_counter INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE recovery_codes (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     code_hash TEXT NOT NULL,
     used_at INTEGER
   );
   CREATE TABLE sessions (
     id_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     mfa_ok INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     ip TEXT,
     user_agent TEXT
   );
   CREATE TABLE setup_state (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     cookie_hash TEXT NOT NULL,
     email TEXT,
     password_hash TEXT,
     totp_secret_enc TEXT,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE auth_failures (
     key TEXT NOT NULL,
     at INTEGER NOT NULL
   );
   CREATE INDEX auth_failures_key ON auth_failures (key, at);`,
  // GitHub App (one per server), its installations, manifest-flow states and
  // webhook deliveries (each processed once).
  `CREATE TABLE github_app (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     app_id INTEGER NOT NULL,
     slug TEXT NOT NULL,
     name TEXT NOT NULL,
     client_id TEXT NOT NULL,
     owner_login TEXT NOT NULL,
     html_url TEXT NOT NULL,
     private_key_enc TEXT NOT NULL,
     webhook_secret_enc TEXT NOT NULL,
     client_secret_enc TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE github_installations (
     id INTEGER PRIMARY KEY,
     account_login TEXT NOT NULL,
     account_type TEXT NOT NULL,
     repository_selection TEXT NOT NULL,
     suspended INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE github_states (
     state_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE webhook_deliveries (
     id TEXT PRIMARY KEY,
     event TEXT NOT NULL,
     received_at INTEGER NOT NULL
   );`,
];

function open(): DatabaseSync {
  mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(config.dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    db.exec(MIGRATIONS[v]!);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec("COMMIT");
  }
  return db;
}

// One connection per server process (kept across dev hot reloads).
const globalForDb = globalThis as unknown as { layerDb?: DatabaseSync };
export const db = (): DatabaseSync => (globalForDb.layerDb ??= open());

export const now = () => Math.floor(Date.now() / 1000);

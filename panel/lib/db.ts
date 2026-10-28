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

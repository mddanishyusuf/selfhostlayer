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
  // Projects (one per deployed app), their deployments and env vars.
  `CREATE TABLE projects (
     id INTEGER PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     repo_owner TEXT NOT NULL,
     repo_name TEXT NOT NULL,
     installation_id INTEGER,
     branch TEXT NOT NULL,
     root_dir TEXT NOT NULL DEFAULT '',
     framework TEXT NOT NULL,
     package_manager TEXT NOT NULL,
     node_version TEXT NOT NULL,
     install_command TEXT,
     build_command TEXT,
     runtime TEXT NOT NULL,
     domains TEXT NOT NULL,
     memory_mb INTEGER NOT NULL DEFAULT 512,
     auto_deploy INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE deployments (
     id INTEGER PRIMARY KEY,
     project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     sha TEXT NOT NULL,
     commit_message TEXT NOT NULL DEFAULT '',
     commit_author TEXT NOT NULL DEFAULT '',
     trigger TEXT NOT NULL,
     status TEXT NOT NULL,
     color TEXT,
     error TEXT,
     steps TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     finished_at INTEGER
   );
   CREATE INDEX deployments_project ON deployments (project_id, id DESC);
   CREATE TABLE project_env (
     project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     key TEXT NOT NULL,
     value_enc TEXT NOT NULL,
     PRIMARY KEY (project_id, key)
   );`,
  // Domains per project: the free host, custom domains (live once their DNS
  // points here) and redirect hosts such as www.
  `CREATE TABLE project_domains (
     id INTEGER PRIMARY KEY,
     project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     host TEXT NOT NULL UNIQUE,
     role TEXT NOT NULL CHECK (role IN ('free', 'primary', 'redirect')),
     redirect_to TEXT,
     status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
     message TEXT,
     created_at INTEGER NOT NULL,
     verified_at INTEGER
   );
   INSERT INTO project_domains (project_id, host, role, status, created_at, verified_at)
     SELECT p.id, j.value, 'free', 'active', p.created_at, p.created_at FROM projects p, json_each(p.domains) j;`,
  // Cron jobs as the user wrote them; the agent turns them into systemd timers.
  `CREATE TABLE project_crons (
     id INTEGER PRIMARY KEY,
     project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     schedule TEXT NOT NULL,
     command TEXT NOT NULL,
     timeout_sec INTEGER NOT NULL DEFAULT 3600,
     created_at INTEGER NOT NULL,
     UNIQUE (project_id, name)
   );`,
  // Alerts: where to send them, and incidents (one open incident per key).
  `CREATE TABLE alert_channels (
     id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('telegram', 'discord', 'webhook')),
     name TEXT NOT NULL,
     config_enc TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE alert_incidents (
     id INTEGER PRIMARY KEY,
     key TEXT NOT NULL,
     title TEXT NOT NULL,
     detail TEXT NOT NULL DEFAULT '',
     link TEXT,
     project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
     opened_at INTEGER NOT NULL,
     resolved_at INTEGER,
     notify_errors TEXT
   );
   CREATE UNIQUE INDEX alert_incidents_open ON alert_incidents (key) WHERE resolved_at IS NULL;`,
  // Backups: one destination (S3-compatible) with the recovery key, and a row per backup.
  `CREATE TABLE backup_settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     provider TEXT NOT NULL,
     config_enc TEXT NOT NULL,
     recovery_key_enc TEXT NOT NULL,
     key_confirmed_at INTEGER,
     schedule_hour INTEGER NOT NULL DEFAULT 3,
     keep INTEGER NOT NULL DEFAULT 14,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE backups (
     id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('app', 'panel')),
     project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
     slug TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
     trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
     object_key TEXT,
     bytes INTEGER,
     contents TEXT,
     error TEXT,
     started_at INTEGER NOT NULL,
     finished_at INTEGER,
     deleted_at INTEGER
   );
   CREATE INDEX backups_by_slug ON backups (kind, slug, started_at);`,
  // Email as an alert channel (SQLite can't change a CHECK, so the table is rebuilt).
  `CREATE TABLE alert_channels_new (
     id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('telegram', 'discord', 'webhook', 'email')),
     name TEXT NOT NULL,
     config_enc TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL
   );
   INSERT INTO alert_channels_new SELECT id, kind, name, config_enc, enabled, created_at FROM alert_channels;
   DROP TABLE alert_channels;
   ALTER TABLE alert_channels_new RENAME TO alert_channels;`,
  // The bucket folder for this server's backups, fixed when they start: moving the panel keeps them together.
  `ALTER TABLE backup_settings ADD COLUMN server_folder TEXT;`,
  // Usage history for the charts: per minute for a day, then hourly for a week (lib/metrics.ts).
  `CREATE TABLE metrics (
     target TEXT NOT NULL,
     step TEXT NOT NULL CHECK (step IN ('minute', 'hour')),
     at INTEGER NOT NULL,
     cpu REAL,
     memory_mb REAL,
     disk_mb REAL,
     PRIMARY KEY (target, step, at)
   );`,
  // Small values kept between requests, like an address the panel waits to move to (lib/panel-state.ts).
  `CREATE TABLE panel_state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL
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

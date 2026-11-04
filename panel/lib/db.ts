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
  // Domains behind Cloudflare's proxy (orange cloud), and what the last DNS check found.
  `ALTER TABLE project_domains ADD COLUMN proxied INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE project_domains ADD COLUMN dns_status TEXT;`,
  // Integrations: projects whose code comes from the catalog instead of GitHub (lib/catalog.ts).
  // Their deployments name the app's version and keep its manifest; the sha is the release (the tarball's checksum).
  `ALTER TABLE projects ADD COLUMN source TEXT NOT NULL DEFAULT 'github';
   ALTER TABLE projects ADD COLUMN catalog_app TEXT;
   ALTER TABLE deployments ADD COLUMN version TEXT;
   ALTER TABLE deployments ADD COLUMN manifest TEXT;`,
  // Private files (a service account key…): kept encrypted, written into each release before its build.
  `CREATE TABLE project_files (
     project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     path TEXT NOT NULL,
     content_enc TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (project_id, path)
   );`,
  // Backups taken before an edit in the database viewer (SQLite can't change a CHECK, so the table is rebuilt).
  `CREATE TABLE backups_new (
     id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('app', 'panel')),
     project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
     slug TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
     trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'edit')),
     object_key TEXT,
     bytes INTEGER,
     contents TEXT,
     error TEXT,
     started_at INTEGER NOT NULL,
     finished_at INTEGER,
     deleted_at INTEGER
   );
   INSERT INTO backups_new SELECT id, kind, project_id, slug, status, trigger, object_key, bytes, contents, error, started_at, finished_at, deleted_at FROM backups;
   DROP TABLE backups;
   ALTER TABLE backups_new RENAME TO backups;
   CREATE INDEX backups_by_slug ON backups (kind, slug, started_at);`,
  // Sites (WordPress, Ghost): what the install needs, and the owner's first password until it's been seen.
  `CREATE TABLE sites (
     project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
     engine TEXT NOT NULL CHECK (engine IN ('wordpress', 'ghost')),
     title TEXT NOT NULL,
     owner_name TEXT NOT NULL,
     owner_email TEXT NOT NULL,
     xmlrpc INTEGER NOT NULL DEFAULT 0,
     password_enc TEXT,
     installed INTEGER NOT NULL DEFAULT 0
   );`,
  // Servers this panel deploys to (PLAN-SERVERS.md); a project's server_id is NULL on the panel's own.
  `CREATE TABLE servers (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     host TEXT NOT NULL UNIQUE,
     port INTEGER NOT NULL DEFAULT 22,
     info TEXT,
     seen_at INTEGER,
     checked_at INTEGER,
     error TEXT,
     created_at INTEGER NOT NULL
   );
   ALTER TABLE projects ADD COLUMN server_id INTEGER REFERENCES servers(id);`,
  // A move to another server (lib/move.ts): where its old copy runs until it's removed (NULL: the panel's own).
  `CREATE TABLE project_moves (
     project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
     moved_from INTEGER,
     at INTEGER NOT NULL
   );`,
  // Workers: long-running processes beside a project's web server (lib/workers.ts, PLAN-PROCESSES.md).
  `CREATE TABLE project_workers (
     id INTEGER PRIMARY KEY,
     project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     command TEXT NOT NULL,
     memory_mb INTEGER NOT NULL DEFAULT 512,
     created_at INTEGER NOT NULL,
     UNIQUE (project_id, name)
   );`,
  // Email's Sync from an app (lib/email-sync.ts, PLAN-EMAIL-2.md): a project's table, read page by page, into a brand's list.
  `CREATE TABLE email_syncs (
     id INTEGER PRIMARY KEY,
     brand_id INTEGER NOT NULL,
     project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     engine TEXT NOT NULL,
     file TEXT,
     source_table TEXT NOT NULL,
     email_column TEXT NOT NULL,
     name_column TEXT,
     field_columns TEXT NOT NULL DEFAULT '[]',
     list_id INTEGER,
     cursor_column TEXT,
     cursor TEXT,
     running INTEGER NOT NULL DEFAULT 0,
     last_run_at INTEGER,
     last_result TEXT,
     totals TEXT NOT NULL DEFAULT '{}',
     created_at INTEGER NOT NULL
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

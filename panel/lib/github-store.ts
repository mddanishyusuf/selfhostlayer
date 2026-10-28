// The GitHub App's state in the panel DB. Secrets (private key, webhook and
// client secrets) are encrypted with the server's secret key.
import { decrypt, encrypt, randomToken, sha256 } from "./crypto";
import { db, now } from "./db";
import type { GithubAppCredentials, Installation, ManifestConversion } from "./github";

export interface StoredApp {
  appId: number;
  slug: string;
  name: string;
  ownerLogin: string;
  htmlUrl: string;
  credentials: GithubAppCredentials;
  webhookSecret: string;
}

interface AppRow {
  app_id: number;
  slug: string;
  name: string;
  client_id: string;
  owner_login: string;
  html_url: string;
  private_key_enc: string;
  webhook_secret_enc: string;
}

export function saveApp(c: ManifestConversion): void {
  db()
    .prepare(
      `INSERT OR REPLACE INTO github_app (id, app_id, slug, name, client_id, owner_login, html_url, private_key_enc, webhook_secret_enc, client_secret_enc, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(c.id, c.slug, c.name, c.client_id, c.owner.login, c.html_url, encrypt(c.pem), encrypt(c.webhook_secret), encrypt(c.client_secret), now());
}

export function getApp(): StoredApp | null {
  const row = db().prepare("SELECT * FROM github_app WHERE id = 1").get() as AppRow | undefined;
  if (!row) return null;
  return {
    appId: row.app_id,
    slug: row.slug,
    name: row.name,
    ownerLogin: row.owner_login,
    htmlUrl: row.html_url,
    credentials: { appId: row.app_id, clientId: row.client_id, privateKey: decrypt(row.private_key_enc) },
    webhookSecret: decrypt(row.webhook_secret_enc),
  };
}

/** One-time state for the manifest flow, tied to the signed-in user (CSRF). */
export function createState(userId: number): string {
  const state = randomToken(24);
  db().prepare("DELETE FROM github_states WHERE expires_at < ?").run(now());
  db().prepare("INSERT INTO github_states (state_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(state), userId, now() + 3600);
  return state;
}

/** True once for a valid, unexpired state issued to this user. */
export function consumeState(state: string, userId: number): boolean {
  const result = db()
    .prepare("DELETE FROM github_states WHERE state_hash = ? AND user_id = ? AND expires_at > ?")
    .run(sha256(state), userId, now());
  return result.changes === 1;
}

export interface StoredInstallation {
  id: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  suspended: boolean;
}

export function upsertInstallation(i: Installation): void {
  db()
    .prepare(
      `INSERT INTO github_installations (id, account_login, account_type, repository_selection, suspended, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET account_login = excluded.account_login, account_type = excluded.account_type,
         repository_selection = excluded.repository_selection, suspended = excluded.suspended`,
    )
    .run(i.id, i.account.login, i.account.type, i.repository_selection, i.suspended_at ? 1 : 0, now());
}

export function removeInstallation(id: number): void {
  db().prepare("DELETE FROM github_installations WHERE id = ?").run(id);
}

export function listInstallations(): StoredInstallation[] {
  return (
    db().prepare("SELECT id, account_login, account_type, repository_selection, suspended FROM github_installations ORDER BY account_login").all() as {
      id: number;
      account_login: string;
      account_type: string;
      repository_selection: string;
      suspended: number;
    }[]
  ).map((r) => ({ id: r.id, accountLogin: r.account_login, accountType: r.account_type, repositorySelection: r.repository_selection, suspended: r.suspended === 1 }));
}

/** Records a webhook delivery; false if this delivery id was already seen. Keeps 7 days. */
export function recordDelivery(id: string, event: string): boolean {
  db().prepare("DELETE FROM webhook_deliveries WHERE received_at < ?").run(now() - 7 * 86400);
  const result = db().prepare("INSERT OR IGNORE INTO webhook_deliveries (id, event, received_at) VALUES (?, ?, ?)").run(id, event, now());
  return result.changes === 1;
}

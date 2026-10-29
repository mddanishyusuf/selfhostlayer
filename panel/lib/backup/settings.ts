// Where backups go (one S3-compatible bucket per server), the recovery key
// that encrypts them, and the schedule.
import { randomBytes } from "node:crypto";
import { decrypt, encrypt } from "../crypto";
import { db } from "../db";
import { newRecoveryKey, parseRecoveryKey } from "./crypt";
import { S3, type S3Config } from "./s3";

export const PROVIDERS = {
  r2: { label: "Cloudflare R2", endpoint: "https://<account-id>.r2.cloudflarestorage.com", region: "auto", hint: "R2 → Manage API tokens → Create token (Object Read & Write). The endpoint is on the bucket's settings page." },
  b2: { label: "Backblaze B2", endpoint: "https://s3.<region>.backblazeb2.com", region: "", hint: "Application Keys → Add a key for this bucket. The endpoint is on the bucket's page (region is the part after s3.)." },
  s3: { label: "AWS S3", endpoint: "https://s3.<region>.amazonaws.com", region: "", hint: "An IAM user with s3:PutObject, GetObject, DeleteObject and ListBucket on this bucket only." },
  hetzner: { label: "Hetzner", endpoint: "https://<location>.your-objectstorage.com", region: "", hint: "Object Storage → S3 credentials. Region is the location (fsn1, nbg1, hel1)." },
  other: { label: "Other", endpoint: "https://…", region: "us-east-1", hint: "Any S3-compatible storage: Wasabi, MinIO, Scaleway, DigitalOcean Spaces." },
} as const;
export type Provider = keyof typeof PROVIDERS;

export interface Destination extends S3Config {
  /** Optional folder inside the bucket, ending in "/" (or empty). */
  prefix: string;
}

export interface BackupSettings {
  provider: Provider;
  destination: Destination;
  recoveryKey: string;
  keyConfirmed: boolean;
  scheduleHour: number;
  keep: number;
  /** <prefix><serverFolder>/ in the bucket; fixed by the first backup (or a panel move). */
  serverFolder: string | null;
}

type Parsed = { ok: true; provider: Provider; destination: Destination } | { ok: false; error: string };

export function parseDestination(form: Record<string, string>): Parsed {
  const provider = form.provider as Provider;
  if (!(provider in PROVIDERS)) return { ok: false, error: "Pick a storage provider." };
  let endpoint: URL;
  try {
    endpoint = new URL(form.endpoint ?? "");
  } catch {
    return { ok: false, error: "The endpoint must be a URL like https://s3.example.com." };
  }
  const local = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost";
  if (endpoint.protocol !== "https:" && !(local && endpoint.protocol === "http:")) return { ok: false, error: "The endpoint must use https." };
  if (endpoint.pathname !== "/" || endpoint.search || endpoint.username) return { ok: false, error: "The endpoint is just the host (https://…), without a bucket or path." };
  if (/[<>]/.test(form.endpoint ?? "")) return { ok: false, error: "Fill in the <placeholder> in the endpoint." };
  const region = (form.region ?? "").trim();
  if (!/^[a-z0-9-]{2,32}$/.test(region)) return { ok: false, error: "Region is something like auto, us-east-1 or eu-central-003." };
  const bucket = (form.bucket ?? "").trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return { ok: false, error: "Bucket names are 3–63 lowercase letters, digits, dots and dashes." };
  const accessKeyId = (form.accessKeyId ?? "").trim();
  const secretAccessKey = (form.secretAccessKey ?? "").trim();
  if (!/^[\x21-\x7e]{3,256}$/.test(accessKeyId) || !/^[\x21-\x7e]{3,256}$/.test(secretAccessKey)) return { ok: false, error: "Enter the access key ID and secret." };
  let prefix = (form.prefix ?? "").trim().replace(/^\/+/, "");
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  if (!/^[A-Za-z0-9._\/-]{0,100}$/.test(prefix) || prefix.includes("//") || prefix.split("/").includes("..")) return { ok: false, error: "The folder may use letters, digits, . _ - and /." };
  return { ok: true, provider, destination: { endpoint: endpoint.origin, region, bucket, accessKeyId, secretAccessKey, prefix } };
}

interface Row {
  provider: string;
  config_enc: string;
  recovery_key_enc: string;
  key_confirmed_at: number | null;
  schedule_hour: number;
  keep: number;
  server_folder: string | null;
}

export function getBackupSettings(): BackupSettings | null {
  const row = db().prepare("SELECT * FROM backup_settings WHERE id = 1").get() as Row | undefined;
  if (!row) return null;
  return {
    provider: row.provider as Provider,
    destination: JSON.parse(decrypt(row.config_enc)) as Destination,
    recoveryKey: decrypt(row.recovery_key_enc),
    keyConfirmed: row.key_confirmed_at !== null,
    scheduleHour: row.schedule_hour,
    keep: row.keep,
    serverFolder: row.server_folder,
  };
}

/** Fixes the bucket folder, if it isn't yet; returns the one in use. */
export function pinServerFolder(folder: string): string {
  db().prepare("UPDATE backup_settings SET server_folder = ? WHERE id = 1 AND server_folder IS NULL").run(folder);
  const row = db().prepare("SELECT server_folder FROM backup_settings WHERE id = 1").get() as { server_folder: string | null } | undefined;
  return row?.server_folder ?? folder;
}

/** Saves the destination. The recovery key is made once and kept when the destination changes, so older backups stay readable. */
export function saveDestination(provider: Provider, destination: Destination): void {
  const now = Date.now();
  const existing = db().prepare("SELECT 1 FROM backup_settings WHERE id = 1").get();
  if (existing) {
    db().prepare("UPDATE backup_settings SET provider = ?, config_enc = ?, updated_at = ? WHERE id = 1").run(provider, encrypt(JSON.stringify(destination)), now);
  } else {
    db()
      .prepare("INSERT INTO backup_settings (id, provider, config_enc, recovery_key_enc, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)")
      .run(provider, encrypt(JSON.stringify(destination)), encrypt(newRecoveryKey()), now, now);
  }
}

export function confirmRecoveryKey(): void {
  db().prepare("UPDATE backup_settings SET key_confirmed_at = ? WHERE id = 1 AND key_confirmed_at IS NULL").run(Date.now());
}

export function saveSchedule(hour: number, keep: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("hour must be 0–23");
  if (!Number.isInteger(keep) || keep < 1 || keep > 365) throw new Error("keep must be 1–365");
  db().prepare("UPDATE backup_settings SET schedule_hour = ?, keep = ?, updated_at = ? WHERE id = 1").run(hour, keep, Date.now());
}

export function recoveryKeyBytes(settings: BackupSettings): Buffer {
  return parseRecoveryKey(settings.recoveryKey);
}

export function storage(destination: Destination, fetchImpl?: typeof fetch): S3 {
  return new S3(destination, fetchImpl);
}

/**
 * Proves the credentials can write, read, list and delete: a small object
 * under the folder, read back and removed. Returns an error message or null.
 */
export async function testDestination(destination: Destination, fetchImpl?: typeof fetch): Promise<string | null> {
  const s3 = storage(destination, fetchImpl);
  const key = `${destination.prefix}.layer-test-${randomBytes(6).toString("hex")}`;
  const body = Buffer.from(`Self Host Layer connection test ${new Date().toISOString()}\n`);
  try {
    await s3.put(key, body);
    const back = Buffer.from(await (await s3.get(key)).arrayBuffer());
    if (!back.equals(body)) return "The storage returned different bytes than were written.";
    const listed = await s3.list(key);
    if (!listed.some((o) => o.key === key)) return "Writing works, but listing the bucket doesn't (the key needs List permission).";
    await s3.delete(key);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

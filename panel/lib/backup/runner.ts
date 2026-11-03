// Runs backups: the agent snapshots an app's data/ into a staging file, the
// panel encrypts it on the fly, uploads it, records it and prunes old ones.
// Restores go the other way. One backup or restore at a time.
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { agent } from "../agent";
import { raise, resolve } from "../alerts/engine";
import { boxConfig } from "../box";
import { fetchStaged, putFile } from "../servers";
import { config } from "../config";
import { db } from "../db";
import { getProject, listProjects, type Project } from "../projects";
import { decryptStream, encryptStream } from "./crypt";
import { getBackupSettings, pinServerFolder, recoveryKeyBytes, storage, type BackupSettings } from "./settings";
import { tarGz } from "./tar";

export const STAGING_DIR = "/var/lib/layer-staging";

export interface Backup {
  id: number;
  kind: "app" | "panel";
  projectId: number | null;
  slug: string;
  status: "running" | "ok" | "failed";
  /** "edit": taken just before a change in the database viewer. */
  trigger: "schedule" | "manual" | "edit";
  objectKey: string | null;
  bytes: number | null;
  contents: { sqlite?: { path: string; bytes: number }[]; postgres?: { bytes: number } | null; mysql?: { bytes: number } | null; mongodb?: { bytes: number } | null } | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

interface Row {
  id: number;
  kind: Backup["kind"];
  project_id: number | null;
  slug: string;
  status: Backup["status"];
  trigger: Backup["trigger"];
  object_key: string | null;
  bytes: number | null;
  contents: string | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

const fromRow = (r: Row): Backup => ({
  id: r.id,
  kind: r.kind,
  projectId: r.project_id,
  slug: r.slug,
  status: r.status,
  trigger: r.trigger,
  objectKey: r.object_key,
  bytes: r.bytes,
  contents: r.contents ? JSON.parse(r.contents) : null,
  error: r.error,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export function listBackups(opts: { slug?: string; limit?: number } = {}): Backup[] {
  const rows = opts.slug
    ? db().prepare("SELECT * FROM backups WHERE kind = 'app' AND slug = ? AND deleted_at IS NULL ORDER BY started_at DESC LIMIT ?").all(opts.slug, opts.limit ?? 50)
    : db().prepare("SELECT * FROM backups WHERE deleted_at IS NULL ORDER BY started_at DESC LIMIT ?").all(opts.limit ?? 50);
  return (rows as unknown as Row[]).map(fromRow);
}

export function getBackup(id: number): Backup | null {
  const row = db().prepare("SELECT * FROM backups WHERE id = ?").get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** This server's folder name in the bucket: its panel address when backups began. */
function hostFolder(): string {
  let host = "server";
  try {
    host = boxConfig().panelHost;
  } catch {
    // dev: no box config
  }
  return host.replace(/[^A-Za-z0-9.-]/g, "-");
}

/** Fixes the folder before the panel's address changes (no-op without backups). */
export function pinBackupFolder(): void {
  if (getBackupSettings()) pinServerFolder(hostFolder());
}

/** Folder for this server's backups in the bucket: <prefix><folder>/, fixed by the first backup. */
export function serverPrefix(settings: BackupSettings): string {
  return `${settings.destination.prefix}${settings.serverFolder ?? pinServerFolder(hostFolder())}/`;
}

function panelLink(path: string): string | null {
  try {
    return `https://${boxConfig().panelHost}${path}`;
  } catch {
    return null;
  }
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

// One at a time, across module copies (Next loads modules twice).
const g = globalThis as unknown as { layerBackupQueue?: Promise<unknown> };
function queued<T>(job: () => Promise<T>): Promise<T> {
  const run = (g.layerBackupQueue ?? Promise.resolve()).then(job, job);
  g.layerBackupQueue = run.catch(() => {});
  return run;
}

/** At startup: backups that were running when the panel stopped never finished. */
export function markInterrupted(): void {
  db().prepare("UPDATE backups SET status = 'failed', error = 'Interrupted: the panel restarted.', finished_at = ? WHERE status = 'running'").run(Date.now());
}

export function isBusy(): boolean {
  return !!db().prepare("SELECT 1 FROM backups WHERE status = 'running'").get();
}

function begin(kind: Backup["kind"], slug: string, projectId: number | null, trigger: Backup["trigger"]): number {
  return Number(
    db().prepare("INSERT INTO backups (kind, project_id, slug, status, trigger, started_at) VALUES (?, ?, ?, 'running', ?, ?)").run(kind, projectId, slug, trigger, Date.now()).lastInsertRowid,
  );
}

function finish(id: number, result: { ok: true; objectKey: string; bytes: number; contents: unknown } | { ok: false; error: string }): void {
  if (result.ok) {
    db()
      .prepare("UPDATE backups SET status = 'ok', object_key = ?, bytes = ?, contents = ?, finished_at = ? WHERE id = ?")
      .run(result.objectKey, result.bytes, JSON.stringify(result.contents), Date.now(), id);
  } else {
    db().prepare("UPDATE backups SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(result.error.slice(0, 1000), Date.now(), id);
  }
}

/** Encrypts a stream and uploads it. Returns the uploaded size. */
async function encryptAndUpload(settings: BackupSettings, key: string, source: Readable): Promise<number> {
  const encrypted = encryptStream(recoveryKeyBytes(settings));
  source.on("error", (err) => encrypted.destroy(err));
  return storage(settings.destination).upload(key, source.pipe(encrypted));
}

/** How many backups taken before edits each app keeps, apart from its scheduled and manual ones. */
export const KEEP_EDIT_BACKUPS = 5;

/**
 * Deletes the oldest successful backups past the retention count. Backups
 * taken before edits count on their own, so a busy afternoon of edits never
 * pushes out the daily ones.
 */
async function prune(settings: BackupSettings, kind: Backup["kind"], slug: string): Promise<void> {
  const past = (edits: boolean, keep: number) =>
    db()
      .prepare(`SELECT id, object_key FROM backups WHERE kind = ? AND slug = ? AND status = 'ok' AND deleted_at IS NULL AND trigger ${edits ? "=" : "<>"} 'edit' ORDER BY started_at DESC LIMIT -1 OFFSET ?`)
      .all(kind, slug, keep) as { id: number; object_key: string }[];
  const old = [...past(false, settings.keep), ...past(true, KEEP_EDIT_BACKUPS)];
  const s3 = storage(settings.destination);
  for (const b of old) {
    try {
      await s3.delete(b.object_key);
      db().prepare("UPDATE backups SET deleted_at = ? WHERE id = ?").run(Date.now(), b.id);
    } catch {
      // Try again after the next backup.
    }
  }
  // Failed attempts are only useful for a while.
  db().prepare("DELETE FROM backups WHERE kind = ? AND slug = ? AND status = 'failed' AND started_at < ?").run(kind, slug, Date.now() - 30 * 86400_000);
}

function requireSettings(): BackupSettings {
  const settings = getBackupSettings();
  if (!settings) throw new Error("Connect a storage bucket first (Server → Backups).");
  if (!settings.keyConfirmed) throw new Error("Save the recovery key first (Server → Backups).");
  return settings;
}

async function backupApp(project: Project, trigger: Backup["trigger"]): Promise<Backup> {
  const settings = requireSettings();
  const id = begin("app", project.slug, project.id, trigger);
  let staged: string | null = null;
  let fetched: string | null = null;
  try {
    const snap = await agent<{ file: string; path: string; bytes: number; sqlite: { path: string; bytes: number }[]; postgres: { bytes: number } | null; mysql: { bytes: number } | null; mongodb: { bytes: number } | null }>("backup.snapshot", { slug: project.slug });
    staged = snap.file;
    const key = `${serverPrefix(settings)}${project.slug}/${stamp(Date.now())}-${id}.tar.gz.enc`;
    // On another server, the snapshot comes over the link first.
    let source = join(STAGING_DIR, snap.file);
    if (project.serverId !== null) {
      const dir = join(config.dataDir, "fetched");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      fetched = join(dir, snap.file);
      await fetchStaged(project.serverId, snap.file, fetched);
      source = fetched;
    }
    const bytes = await encryptAndUpload(settings, key, createReadStream(source));
    finish(id, { ok: true, objectKey: key, bytes, contents: { sqlite: snap.sqlite, postgres: snap.postgres, mysql: snap.mysql, mongodb: snap.mongodb, archiveBytes: snap.bytes } });
    await resolve(`backup:${project.slug}`, "The latest backup worked.");
    await prune(settings, "app", project.slug);
  } catch (err) {
    const message = (err as Error).message;
    finish(id, { ok: false, error: message });
    await raise(`backup:${project.slug}`, { title: `Backup failed: ${project.slug}`, detail: message, link: panelLink(`/projects/${project.slug}/backups`), projectId: project.id });
  } finally {
    if (staged) await agent("backup.discard", { file: staged }, { server: project.serverId }).catch(() => {});
    if (fetched) rmSync(fetched, { force: true });
  }
  return getBackup(id)!;
}

/**
 * The panel's own state: a consistent copy of its database plus the key that
 * decrypts the secrets in it, as a tar.gz. Enough to rebuild the panel.
 */
async function backupPanel(trigger: Backup["trigger"]): Promise<Backup> {
  const settings = requireSettings();
  const id = begin("panel", "_panel", null, trigger);
  const dir = join(config.dataDir, `backup-${randomBytes(4).toString("hex")}`);
  try {
    mkdirSync(dir, { mode: 0o700 });
    const source = new DatabaseSync(config.dbPath, { readOnly: true });
    try {
      await sqliteBackup(source, join(dir, "panel.db"));
    } finally {
      source.close();
    }
    const key = `${serverPrefix(settings)}_panel/${stamp(Date.now())}-${id}.tar.gz.enc`;
    const archive = tarGz([
      { name: "panel.db", path: join(dir, "panel.db") },
      { name: "secret.key", path: config.secretKeyFile },
    ]);
    const bytes = await encryptAndUpload(settings, key, archive);
    finish(id, { ok: true, objectKey: key, bytes, contents: {} });
    await prune(settings, "panel", "_panel");
  } catch (err) {
    finish(id, { ok: false, error: (err as Error).message });
    await raise("backup:_panel", { title: "Backup failed: the panel itself", detail: (err as Error).message, link: panelLink("/settings/backups") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return getBackup(id)!;
}

/** Apps that have data worth backing up (static sites don't). */
export const backupProjects = () => listProjects().filter((p) => p.runtime.kind !== "static");

export function backUpProject(project: Project, trigger: Backup["trigger"] = "manual"): Promise<Backup> {
  return queued(() => backupApp(project, trigger));
}

/** A backup before an edit is reused for this long: a run of quick edits shares one. */
export const EDIT_BACKUP_REUSE_MS = 10 * 60_000;

/** Whether edits can be backed up first: a bucket is connected and its recovery key saved. */
export const canBackUpEdits = () => {
  const settings = getBackupSettings();
  return !!settings?.keyConfirmed;
};

/** The newest successful backup of an app (any trigger) from the last few minutes, if there is one. */
export function recentBackup(slug: string, now = Date.now()): Backup | null {
  const row = db()
    .prepare("SELECT * FROM backups WHERE kind = 'app' AND slug = ? AND status = 'ok' AND deleted_at IS NULL AND finished_at >= ? ORDER BY finished_at DESC LIMIT 1")
    .get(slug, now - EDIT_BACKUP_REUSE_MS) as Row | undefined;
  return row ? fromRow(row) : null;
}

/**
 * Backs an app up before an edit, unless it was backed up in the last ten
 * minutes. Throws if the backup fails: then the edit doesn't happen.
 */
export async function backUpBeforeEdit(project: Project): Promise<Backup> {
  const recent = recentBackup(project.slug);
  if (recent) return recent;
  const backup = await backUpProject(project, "edit");
  if (backup.status !== "ok") throw new Error(`The backup before this change failed, so nothing was changed: ${backup.error ?? "unknown error"}`);
  return backup;
}

/** The panel, then every app. */
export function backUpEverything(trigger: Backup["trigger"]): Promise<Backup[]> {
  return queued(async () => {
    const results = [await backupPanel(trigger)];
    for (const p of backupProjects()) results.push(await backupApp(p, trigger));
    return results;
  });
}

/**
 * Downloads a backup, checks and decrypts it completely, then has the agent
 * swap it in (the app restarts on the restored data).
 */
export function restoreBackup(id: number): Promise<{ previous: string }> {
  return queued(async () => {
    const settings = requireSettings();
    const b = getBackup(id);
    if (!b || b.kind !== "app" || b.status !== "ok" || !b.objectKey) throw new Error("That backup can't be restored.");
    const dir = join(config.dataDir, "restore");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = `${b.slug}-${stamp(b.startedAt).replace("-", "")}-${randomBytes(4).toString("hex")}.tar.gz`;
    const path = join(dir, file);
    try {
      const res = await storage(settings.destination).get(b.objectKey);
      if (!res.body) throw new Error("The storage returned an empty backup.");
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), decryptStream(recoveryKeyBytes(settings)), createWriteStream(path, { mode: 0o600 }));
      // A project on another server: the file goes over the link to its restore folder.
      const serverId = b.projectId !== null ? (getProject(b.projectId)?.serverId ?? null) : null;
      if (serverId !== null) await putFile(serverId, path, file);
      const result = await agent<{ previous: string }>("backup.restore", { slug: b.slug, file });
      return { previous: result.previous };
    } finally {
      rmSync(path, { force: true });
    }
  });
}

/** For the monitor: the scheduled run, once a day at the chosen hour (server time). */
export async function scheduledTick(now = new Date()): Promise<void> {
  const settings = getBackupSettings();
  if (!settings?.keyConfirmed || now.getHours() !== settings.scheduleHour) return;
  const startOfHour = new Date(now);
  startOfHour.setMinutes(0, 0, 0);
  const done = db().prepare("SELECT 1 FROM backups WHERE trigger = 'schedule' AND kind = 'panel' AND started_at >= ?").get(startOfHour.getTime() - 3600_000);
  if (done || isBusy()) return;
  await backUpEverything("schedule");
}

/** For the monitor: an app with no successful backup for 26 hours (while backups are on). */
export function overdueSlugs(now = Date.now()): string[] {
  const settings = getBackupSettings();
  if (!settings?.keyConfirmed) return [];
  const since = now - 26 * 3600_000;
  return backupProjects()
    .filter((p) => {
      const last = db().prepare("SELECT max(started_at) AS at FROM backups WHERE kind = 'app' AND slug = ? AND status = 'ok'").get(p.slug) as { at: number | null };
      const created = db().prepare("SELECT min(started_at) AS at FROM backups WHERE kind = 'app' AND slug = ?").get(p.slug) as { at: number | null };
      // Only once it has been tried: a brand-new app gets its first backup at the next scheduled run.
      return created.at !== null && (last.at ?? 0) < since;
    })
    .map((p) => p.slug);
}

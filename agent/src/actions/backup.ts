// Backups: the agent makes a consistent snapshot of an app's data/ (as the app
// user, in its sandbox) into a staging file the panel reads, encrypts and
// uploads; and restores one the panel downloaded. Bucket credentials and the
// encryption key never reach the agent.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, createReadStream, existsSync, fchmodSync, fchownSync, fstatSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertSlug, ValidationError } from "@layer/protocol";
import type { ActionTable, CallIO, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { childOf, ensureDir, lookupGid, lookupUser } from "../fsutil.ts";
import { IMPORT_JOB, RESTORE_JOB, SNAPSHOT_JOB } from "../jobs.ts";
import { sandboxArgs, SYSTEMD_RUN } from "../sandbox.ts";
import { appLayout } from "./app.ts";
import { diskGuard } from "./build.ts";
import { redisUnit } from "../templates/redis.ts";
import { readServices } from "./service.ts";

const STAGED_FILE = /^[a-z][a-z0-9-]{0,62}-[0-9]{14}-[0-9a-f]{8}\.tar\.gz$/;
/** Staged snapshots nobody collected (the panel crashed mid-upload) go after a day. */
const STALE_MS = 24 * 3600 * 1000;

function assertStagedName(value: unknown, field: string): string {
  if (typeof value !== "string" || !STAGED_FILE.test(value)) throw new ValidationError(field, "must be a backup file name like piqo-20261029030000-1a2b3c4d.tar.gz");
  return value;
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
/** A folder suffix that two restores or imports in the same second can't share. */
const runId = () => `${stamp()}-${randomBytes(3).toString("hex")}`;

async function requireAppUser(ctx: Context, slug: string) {
  const app = appLayout(ctx, slug);
  const user = await lookupUser(ctx.exec, app.user);
  if (!user || !existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  return { app, user };
}

async function stagingDir(ctx: Context): Promise<string> {
  const gid = ctx.paths.socketGroup ? await lookupGid(ctx.exec, ctx.paths.socketGroup) : null;
  if (ctx.paths.socketGroup && gid === null) throw new Error(`group ${ctx.paths.socketGroup} doesn't exist`);
  // root:layer 750: the panel may read snapshots, apps can't even list them.
  ensureDir(ctx.paths.stagingDir, 0o750, gid === null ? undefined : { uid: process.getuid?.() ?? 0, gid });
  return ctx.paths.stagingDir;
}

function removeStale(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (!STAGED_FILE.test(name)) continue;
    const file = join(dir, name);
    if (Date.now() - statSync(file).mtimeMs > STALE_MS) rmSync(file, { force: true });
  }
}

async function backupSnapshot(params: Params, ctx: Context, io: CallIO) {
  const slug = assertSlug(params.slug);
  const { app, user } = await requireAppUser(ctx, slug);
  if (!existsSync(app.data)) throw new ActionError("not_found", `${slug} has no data folder`);
  diskGuard(ctx);
  const dir = await stagingDir(ctx);
  removeStale(dir);

  const services = readServices(ctx, slug);
  const hasDatabase = Boolean(services.postgres ?? services.mysql ?? services.mongodb);
  const name = `${slug}-${stamp()}-${randomBytes(4).toString("hex")}.tar.gz`;
  const file = join(dir, name);
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640);
  let output = "";
  let code: number;
  try {
    const gid = ctx.paths.socketGroup ? await lookupGid(ctx.exec, ctx.paths.socketGroup) : null;
    if (gid !== null) fchownSync(fd, process.getuid?.() ?? 0, gid);
    // Explicitly: the agent's umask (077) would leave it 600, unreadable for the panel.
    fchmodSync(fd, 0o640);
    const unit = `layer-backup-${slug}.service`;
    await ctx.exec(BIN.systemctl, ["reset-failed", unit], { allowFail: true });
    ({ code } = await ctx.spawn(
      SYSTEMD_RUN,
      sandboxArgs({
        unit,
        user: user.name,
        cwd: app.data,
        // Writable only so SQLite can open WAL databases (it touches -shm).
        readWrite: [app.data],
        env: { PATH: "/usr/bin:/bin" },
        // DATABASE_URL and MONGODB_URI, to dump the app's databases with its own logins.
        envFiles: [join(app.etcDir, "services.env")],
        memoryMb: 512,
        timeoutSec: 3600,
        network: hasDatabase ? "localhost" : false,
        command: [ctx.paths.runtimeNode, "--no-warnings", "-e", SNAPSHOT_JOB, app.data],
      }),
      {
        stdout: fd,
        onData: (chunk) => {
          output += chunk;
          for (const line of chunk.split("\n")) if (line && !line.startsWith("LAYER-SNAPSHOT ")) io.emit(line + "\n");
        },
      },
    ));
  } finally {
    closeSync(fd);
  }
  if (code !== 0) {
    rmSync(file, { force: true });
    const reason = output.split("\n").filter((l) => l.startsWith("layer: ")).at(-1)?.slice(7);
    throw new ActionError("snapshot_failed", reason ?? `the snapshot job exited ${code}`);
  }
  const manifest = /^LAYER-SNAPSHOT (.+)$/m.exec(output);
  const parsed = manifest
    ? (JSON.parse(manifest[1]!) as { sqlite: { path: string; bytes: number }[]; postgres?: { bytes: number } | null; mysql?: { bytes: number } | null; mongodb?: { bytes: number } | null })
    : null;
  return { slug, file: name, path: file, bytes: statSync(file).size, sqlite: parsed?.sqlite ?? [], postgres: parsed?.postgres ?? null, mysql: parsed?.mysql ?? null, mongodb: parsed?.mongodb ?? null };
}

/**
 * Units running now, to stop around a restore or import: the app's colors,
 * then its Redis (its files are in data/redis, so it must reload them).
 * Started again in reverse order: Redis first, then the app.
 */
async function activeUnits(ctx: Context, slug: string): Promise<string[]> {
  const units = [`app-${slug}@blue.service`, `app-${slug}@green.service`, redisUnit(slug)];
  const active = [];
  for (const unit of units) {
    const { stdout } = await ctx.exec(BIN.systemctl, ["is-active", unit], { allowFail: true });
    if (stdout.trim() === "active" || stdout.trim() === "activating") active.push(unit);
  }
  return active;
}

/** Starts what activeUnits stopped. data/ may be new, so Redis gets its folder back first. */
async function startAgain(ctx: Context, slug: string, units: string[]): Promise<void> {
  if (readServices(ctx, slug).redis) {
    const app = appLayout(ctx, slug);
    const user = await lookupUser(ctx.exec, app.user);
    if (user) ensureDir(join(app.data, "redis"), 0o700, { uid: user.uid, gid: user.gid });
  }
  for (const unit of [...units].reverse()) await ctx.exec(BIN.systemctl, ["start", unit], { allowFail: true });
}

/**
 * A file the panel wrote into the restore folder. Opened without following
 * symlinks and checked to really be the panel's, so a compromised panel
 * can't make root read some other file into an app.
 */
async function openPanelFile(ctx: Context, name: string): Promise<number> {
  const file = childOf(ctx.paths.restoreDir, name);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new ActionError("not_found", `${name} isn't in ${ctx.paths.restoreDir}`);
  }
  const st = fstatSync(fd);
  const panel = ctx.paths.panelUser ? await lookupUser(ctx.exec, ctx.paths.panelUser) : null;
  if (!st.isFile() || (panel && st.uid !== panel.uid)) {
    closeSync(fd);
    throw new ActionError("forbidden", `${name} must be a regular file owned by ${ctx.paths.panelUser}`);
  }
  return fd;
}

async function backupRestore(params: Params, ctx: Context, io: CallIO) {
  const slug = assertSlug(params.slug);
  const name = assertStagedName(params.file, "file");
  const { app, user } = await requireAppUser(ctx, slug);
  const fd = await openPanelFile(ctx, name);
  const services = readServices(ctx, slug);

  const units = await activeUnits(ctx, slug);
  for (const unit of units) await ctx.exec(BIN.systemctl, ["stop", unit]);
  const when = runId();
  let code: number;
  try {
    const unit = `layer-restore-${slug}.service`;
    await ctx.exec(BIN.systemctl, ["reset-failed", unit], { allowFail: true });
    ({ code } = await ctx.spawn(
      SYSTEMD_RUN,
      sandboxArgs({
        unit,
        user: user.name,
        cwd: app.appDir,
        readWrite: [app.appDir],
        env: { PATH: "/usr/bin:/bin" },
        envFiles: [join(app.etcDir, "services.env")],
        memoryMb: 512,
        timeoutSec: 3600,
        network: services.postgres || services.mysql || services.mongodb ? "localhost" : false,
        command: ["/bin/sh", "-c", RESTORE_JOB, "layer-restore", app.appDir, when],
      }),
      { onData: io.emit, stdin: createReadStream("", { fd }) },
    ));
  } finally {
    // Whatever happened, the app runs again (on the restored data, or the old).
    await startAgain(ctx, slug, units);
  }
  if (code === 2) throw new ActionError("restore_failed", `the files of ${name} were restored, but loading its database dump failed (see the output above)`);
  if (code !== 0) throw new ActionError("restore_failed", `restoring ${name} failed (exit ${code}); data/ is unchanged`);
  return { slug, restored: name, previous: `data.before-restore-${when}`, restarted: units };
}

/** Keeps only the folder the latest restore or import replaced. */
function pruneReplaced(appDir: string, keep: string): void {
  for (const name of readdirSync(appDir)) {
    if (name.startsWith("data.before-restore-") && name !== keep) rmSync(join(appDir, name), { recursive: true, force: true });
  }
}

/**
 * Data from somewhere else (another server, a hand-made archive) replaces an
 * app's data/. Everything is unpacked and checked first, while the app keeps
 * running; only then is the app stopped for the swap. A bad archive or a
 * damaged SQLite file changes nothing.
 */
async function dataImport(params: Params, ctx: Context, io: CallIO) {
  const slug = assertSlug(params.slug);
  const name = assertStagedName(params.file, "file");
  const { app, user } = await requireAppUser(ctx, slug);
  const fd = await openPanelFile(ctx, name);
  // gzip, or a plain tar ("ustar" at byte 257). Read at an explicit position, so stdin still starts at 0.
  const head = Buffer.alloc(262);
  const n = readSync(fd, head, 0, head.length, 0);
  const gzip = n >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  if (!gzip && head.subarray(257, 262).toString("latin1") !== "ustar") {
    closeSync(fd);
    throw new ActionError("bad_archive", `${name} isn't a .tar.gz or .tar archive`);
  }
  try {
    diskGuard(ctx);
  } catch (err) {
    closeSync(fd);
    throw err;
  }

  const when = runId();
  const work = join(app.appDir, `data.importing-${when}`);
  let output = "";
  let code: number;
  try {
    const unit = `layer-import-${slug}.service`;
    await ctx.exec(BIN.systemctl, ["reset-failed", unit], { allowFail: true });
    ({ code } = await ctx.spawn(
      SYSTEMD_RUN,
      sandboxArgs({
        unit,
        user: user.name,
        cwd: app.appDir,
        readWrite: [app.appDir],
        env: { PATH: "/usr/bin:/bin" },
        memoryMb: 512,
        timeoutSec: 3600,
        network: false,
        command: [ctx.paths.runtimeNode, "--no-warnings", "-e", IMPORT_JOB, app.appDir, when, gzip ? "gzip" : "tar"],
      }),
      {
        stdin: createReadStream("", { fd }),
        onData: (chunk) => {
          output += chunk;
          for (const line of chunk.split("\n")) if (line && !line.startsWith("LAYER-IMPORT ")) io.emit(line + "\n");
        },
      },
    ));
  } catch (err) {
    rmSync(work, { recursive: true, force: true });
    throw err;
  }
  const report = /^LAYER-IMPORT (.+)$/m.exec(output);
  if (code !== 0 || !report) {
    rmSync(work, { recursive: true, force: true });
    const reason = output.split("\n").filter((l) => l.startsWith("layer: ")).at(-1)?.slice(7);
    throw new ActionError("import_failed", reason ?? `the import job exited ${code}; data/ is unchanged`);
  }
  const result = JSON.parse(report[1]!) as { root: string; sqlite: { path: string; bytes: number }[]; files: number; bytes: number };
  // The job ran as the app: its folder name is checked like any other input.
  const source = result.root ? childOf(work, result.root) : work;

  const units = await activeUnits(ctx, slug);
  for (const unit of units) await ctx.exec(BIN.systemctl, ["stop", unit]);
  const previous = `data.before-restore-${when}`;
  try {
    const had = existsSync(app.data);
    if (had) renameSync(app.data, join(app.appDir, previous));
    try {
      renameSync(source, app.data);
    } catch (err) {
      if (had) renameSync(join(app.appDir, previous), app.data);
      throw err;
    }
    chmodSync(app.data, 0o700);
    pruneReplaced(app.appDir, previous);
  } finally {
    // Whatever happened: no half-imported folder stays, and the app runs again.
    rmSync(work, { recursive: true, force: true });
    await startAgain(ctx, slug, units);
  }
  return { slug, imported: name, previous, sqlite: result.sqlite, files: result.files, bytes: result.bytes, restarted: units };
}

async function backupDiscard(params: Params, ctx: Context) {
  const name = assertStagedName(params.file, "file");
  const file = childOf(ctx.paths.stagingDir, name);
  const existed = existsSync(file);
  rmSync(file, { force: true });
  return { file: name, discarded: existed };
}

export const backupActions: ActionTable = {
  // The build lock: a snapshot is heavy on disk, so it queues behind builds
  // instead of competing with them, and never blocks proxy or unit changes.
  "backup.snapshot": { mutates: true, lock: "build", run: backupSnapshot },
  "backup.restore": { mutates: true, run: backupRestore },
  "backup.discard": { mutates: true, run: backupDiscard },
  // Heavy on disk like a snapshot, so it queues behind builds too.
  "data.import": { mutates: true, lock: "build", run: dataImport },
};

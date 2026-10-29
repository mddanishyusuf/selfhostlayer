// Backups: the agent makes a consistent snapshot of an app's data/ (as the app
// user, in its sandbox) into a staging file the panel reads, encrypts and
// uploads; and restores one the panel downloaded. Bucket credentials and the
// encryption key never reach the agent.
import { randomBytes } from "node:crypto";
import { closeSync, constants, createReadStream, existsSync, fchmodSync, fchownSync, fstatSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertSlug, ValidationError } from "@layer/protocol";
import type { ActionTable, CallIO, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { childOf, ensureDir, lookupGid, lookupUser } from "../fsutil.ts";
import { RESTORE_JOB, SNAPSHOT_JOB } from "../jobs.ts";
import { sandboxArgs, SYSTEMD_RUN } from "../sandbox.ts";
import { appLayout } from "./app.ts";
import { diskGuard } from "./build.ts";

const STAGED_FILE = /^[a-z][a-z0-9-]{0,62}-[0-9]{14}-[0-9a-f]{8}\.tar\.gz$/;
/** Staged snapshots nobody collected (the panel crashed mid-upload) go after a day. */
const STALE_MS = 24 * 3600 * 1000;

function assertStagedName(value: unknown, field: string): string {
  if (typeof value !== "string" || !STAGED_FILE.test(value)) throw new ValidationError(field, "must be a backup file name like piqo-20261029030000-1a2b3c4d.tar.gz");
  return value;
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14);

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
        memoryMb: 512,
        timeoutSec: 3600,
        network: false,
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
  const sqlite = manifest ? (JSON.parse(manifest[1]!) as { sqlite: { path: string; bytes: number }[] }).sqlite : [];
  return { slug, file: name, path: file, bytes: statSync(file).size, sqlite };
}

/** Units of this app that are running now, to stop around a restore and start again after. */
async function activeUnits(ctx: Context, slug: string): Promise<string[]> {
  const units = [`app-${slug}@blue.service`, `app-${slug}@green.service`];
  const active = [];
  for (const unit of units) {
    const { stdout } = await ctx.exec(BIN.systemctl, ["is-active", unit], { allowFail: true });
    if (stdout.trim() === "active" || stdout.trim() === "activating") active.push(unit);
  }
  return active;
}

async function backupRestore(params: Params, ctx: Context, io: CallIO) {
  const slug = assertSlug(params.slug);
  const name = assertStagedName(params.file, "file");
  const { app, user } = await requireAppUser(ctx, slug);
  const file = childOf(ctx.paths.restoreDir, name);

  // The panel wrote this file. Open it without following symlinks and check
  // it really is the panel's, so a compromised panel can't make root read
  // some other file into an app.
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

  const units = await activeUnits(ctx, slug);
  for (const unit of units) await ctx.exec(BIN.systemctl, ["stop", unit]);
  const when = stamp();
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
        memoryMb: 512,
        timeoutSec: 3600,
        network: false,
        command: ["/bin/sh", "-c", RESTORE_JOB, "layer-restore", app.appDir, when],
      }),
      { onData: io.emit, stdin: createReadStream("", { fd }) },
    ));
  } finally {
    // Whatever happened, the app runs again (on the restored data, or the old).
    for (const unit of units) await ctx.exec(BIN.systemctl, ["start", unit], { allowFail: true });
  }
  if (code !== 0) throw new ActionError("restore_failed", `restoring ${name} failed (exit ${code}); data/ is unchanged`);
  return { slug, restored: name, previous: `data.before-restore-${when}`, restarted: units };
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
};

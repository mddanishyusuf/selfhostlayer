import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fchownSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Exec } from "./exec.ts";
import { BIN } from "./exec.ts";

/** join(root, name), refusing anything that isn't a direct child of root. */
export function childOf(root: string, name: string): string {
  const path = resolve(root, name);
  if (dirname(path) !== resolve(root) || name.includes("/")) {
    throw new Error(`refusing path outside ${root}: ${name}`);
  }
  return path;
}

/** Writes via a temp file + fsync + rename, so readers never see half a file. */
export function writeFileAtomic(path: string, content: string, mode: number): void {
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  record(path, content, mode);
}

// Every file the agent generates (units, Caddy sites, env files, the box
// config) is recorded as it's written, so `layer repair` can put back what
// someone edited or deleted by hand. owns() says which paths count.
export interface ManagedRecord {
  path: string;
  mode: number;
  content: string;
}
interface Managed {
  dir: string;
  owns: (path: string) => boolean;
}
let managed: Managed | null = null;

/** Turns recording on (the agent at start, tests) or off (null). */
export function manageFiles(config: Managed | null): void {
  managed = config;
}

const recordFile = (dir: string, path: string) => join(dir, `${createHash("sha256").update(path).digest("hex")}.json`);

function record(path: string, content: string, mode: number): void {
  if (!managed?.owns(path)) return;
  mkdirSync(managed.dir, { recursive: true, mode: 0o700 });
  const file = recordFile(managed.dir, path);
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify({ path, mode, content } satisfies ManagedRecord), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Deletes a generated file and forgets it. */
export function removeManaged(path: string): void {
  rmSync(path, { force: true });
  if (managed) rmSync(recordFile(managed.dir, path), { force: true });
}

export function listManaged(): ManagedRecord[] {
  if (!managed || !existsSync(managed.dir)) return [];
  const dir = managed.dir;
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")) as ManagedRecord);
}

/** Forgets every file under a folder that was removed as a whole (an app's /etc/layer/apps/<slug>). */
export function forgetManagedUnder(dir: string): void {
  if (!managed) return;
  for (const r of listManaged()) if (r.path.startsWith(`${dir}/`)) rmSync(recordFile(managed.dir, r.path), { force: true });
}

/** Records files written before recording existed (older installs), as they are now. */
export function adoptManaged(paths: string[]): number {
  if (!managed) return 0;
  let adopted = 0;
  for (const path of paths) {
    if (!managed.owns(path) || existsSync(recordFile(managed.dir, path))) continue;
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      record(path, readFileSync(path, "utf8"), st.mode & 0o777);
      adopted++;
    } catch {
      // gone meanwhile
    }
  }
  return adopted;
}

/**
 * mkdir -p plus an exact owner and mode, also on dirs that already exist.
 * The last path component is opened with O_NOFOLLOW and changed through the
 * file descriptor: an app user can replace a folder inside its own tree with a
 * symlink (say to /etc), and root must never chown or chmod through it.
 */
export function ensureDir(path: string, mode: number, owner?: { uid: number; gid: number }): void {
  mkdirSync(path, { recursive: true, mode });
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") throw new Error(`refusing ${path}: it is not a real directory (symlink?)`);
    throw err;
  }
  try {
    if (owner) fchownSync(fd, owner.uid, owner.gid);
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

export interface SystemUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

export async function lookupUser(exec: Exec, name: string): Promise<SystemUser | null> {
  const { code, stdout } = await exec(BIN.getent, ["passwd", name], { allowFail: true });
  if (code !== 0) return null;
  const [, , uid, gid, , home] = stdout.trim().split(":");
  return { name, uid: Number(uid), gid: Number(gid), home: home ?? "" };
}

export async function lookupGid(exec: Exec, group: string): Promise<number | null> {
  const { code, stdout } = await exec(BIN.getent, ["group", group], { allowFail: true });
  if (code !== 0) return null;
  return Number(stdout.trim().split(":")[2]);
}

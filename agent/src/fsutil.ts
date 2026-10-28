import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
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
}

/** mkdir -p plus an exact owner and mode, also on dirs that already exist. */
export function ensureDir(path: string, mode: number, owner?: { uid: number; gid: number }): void {
  mkdirSync(path, { recursive: true, mode });
  if (owner) chownSync(path, owner.uid, owner.gid);
  chmodSync(path, mode);
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

// MySQL 8 for Ghost sites: Oracle's build from its signed tarball (checked
// with gpgv against the key pinned in the agent), unpacked read-only into
// /opt/layer/mysql/<version>, run as its own user on 127.0.0.1:3307 beside
// MariaDB. One server; a user and database per site. See PLAN-SITES.md.
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { assertSlug, ValidationError } from "@layer/protocol";
import type { ActionTable, CallIO, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { ensureDir, lookupUser, writeFileAtomic } from "../fsutil.ts";
import { SYSTEMD_RUN } from "../sandbox.ts";
import { MYSQL_SIGNING_KEY } from "../templates/mysql8-key.ts";
import { MYSQL8, mysql8Bin, mysql8Compat, renderMysql8Conf, renderMysql8Unit } from "../templates/mysql8.ts";
import { appLayout } from "./app.ts";
import { grantPattern, pgName, readServices, writeServices } from "./service.ts";

interface Mysql8State {
  version: string;
  /** root's password, set during the first start (socket only). */
  password: string;
}

const stateFile = (ctx: Context) => join(ctx.paths.managedDir, "..", "mysql8-admin.json");

export function mysql8State(ctx: Context): Mysql8State | null {
  try {
    const s = JSON.parse(readFileSync(stateFile(ctx), "utf8")) as Mysql8State;
    return existsSync(mysql8Bin(s.version, "mysqld")) ? s : null;
  } catch {
    return null;
  }
}

/** The OpenPGP key in its binary form, for gpgv's --keyring. */
function keyring(): Buffer {
  const body = MYSQL_SIGNING_KEY.split(/\r?\n\r?\n/)[1]!.split(/\r?\n=/)[0]!;
  return Buffer.from(body.replace(/\s+/g, ""), "base64");
}

/**
 * Downloads a big file with resumes: each try asks for the rest (Range), so a
 * dropped connection costs a retry, not the whole file.
 */
async function downloadResumable(url: string, path: string, io: CallIO, maxBytes = 1.2e9): Promise<void> {
  let lastShown = -1;
  for (let attempt = 1; attempt <= 12; attempt++) {
    const have = existsSync(path) ? statSync(path).size : 0;
    // No bytes for 90 seconds: give up on this connection and resume on a new one.
    const stall = new AbortController();
    let idle = setTimeout(() => stall.abort(new Error("no data for 90 seconds")), 90_000);
    const alive = () => {
      clearTimeout(idle);
      idle = setTimeout(() => stall.abort(new Error("no data for 90 seconds")), 90_000);
    };
    try {
      const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: stall.signal });
      if (res.status === 416) return; // Already whole.
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const resumed = res.status === 206;
      const total = (resumed ? have : 0) + Number(res.headers.get("content-length") ?? 0);
      if (total > maxBytes) throw new ActionError("download_failed", `${url} is bigger than expected`);
      let got = resumed ? have : 0;
      const body = Readable.fromWeb(res.body as ReadableStream);
      body.on("data", (c: Buffer) => {
        alive();
        got += c.length;
        const pct = total ? Math.floor((got / total) * 10) : -1;
        if (pct !== lastShown) {
          lastShown = pct;
          if (pct >= 0) io.emit(`  ${pct * 10}% of ${Math.round(total / 1048576)} MB\n`);
        }
      });
      await pipeline(body, createWriteStream(path, { flags: resumed ? "a" : "w", mode: 0o600 }));
      if (!total || statSync(path).size === total) return;
    } catch (err) {
      if (err instanceof ActionError) throw err;
      io.emit(`  the download stopped (${(err as Error).message}), resuming…\n`);
    } finally {
      clearTimeout(idle);
    }
    await new Promise((r) => setTimeout(r, Math.min(30_000, 2000 * attempt)));
  }
  throw new ActionError("download_failed", `couldn't download ${url}`);
}

/** The admin client, as root over the socket, with the password in a root-only file (never in arguments). */
async function admin(ctx: Context, sql: string, opts: { allowFail?: boolean; password?: string | null } = {}) {
  const state = mysql8State(ctx);
  const version = state?.version ?? MYSQL8.version;
  const password = opts.password === undefined ? state?.password : opts.password;
  const dir = mkdtempSync(join(ctx.paths.managedDir, "..", "mysql8-"));
  try {
    const cnf = join(dir, "client.cnf");
    writeFileSync(cnf, `[client]\nuser=root\nsocket=${MYSQL8.runDir}/mysqld.sock\n${password ? `password="${password}"\n` : ""}`, { mode: 0o600 });
    return await ctx.exec(mysql8Bin(version, "mysql"), [`--defaults-extra-file=${cnf}`, "--batch", "--skip-column-names"], { allowFail: opts.allowFail, timeoutMs: 120_000, input: sql, env: { LD_LIBRARY_PATH: mysql8Compat(version) } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitFor(ctx: Context, password: string | null): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if ((await admin(ctx, "SELECT 1", { allowFail: true, password })).code === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  const log = await ctx.exec(BIN.journalctl, ["-u", MYSQL8.unit, "-n", "5", "--no-pager", "-o", "cat"], { allowFail: true });
  throw new ActionError("start_failed", `MySQL 8 didn't come up: ${log.stdout.trim().split("\n").slice(-2).join(" ")}`);
}

function apt(ctx: Context, args: string[]) {
  return ctx.exec(SYSTEMD_RUN, ["--quiet", "--wait", "--pipe", "--collect", "--unit=layer-apt-install", "--setenv=DEBIAN_FRONTEND=noninteractive", "--", BIN.aptGet, ...args], { timeoutMs: 600_000, allowFail: true });
}

export async function installMysql8(ctx: Context, io: CallIO) {
  const already = mysql8State(ctx);
  if (already) return { name: "mysql8", installed: true, version: already.version, already: true };
  const version = MYSQL8.version;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!arch) throw new ActionError("unsupported", `MySQL 8 has no build for ${process.arch}`);

  io.emit("Adding what MySQL 8 needs (libaio, libnuma)…\n");
  await apt(ctx, ["update", "-q"]);
  const libs = await apt(ctx, ["install", "-y", "-q", "--no-install-recommends", "libnuma1", "gpgv", "xz-utils", "libaio1t64"]);
  if (libs.code !== 0) await apt(ctx, ["install", "-y", "-q", "--no-install-recommends", "libnuma1", "gpgv", "xz-utils", "libaio1"]);

  const name = MYSQL8.tarball(version, arch);
  ensureDir(ctx.paths.sitesCache, 0o755);
  const file = join(ctx.paths.sitesCache, name);
  io.emit(`Downloading ${name}…\n`);
  await downloadResumable(`${MYSQL8.base}/${name}`, file, io);
  const sig = `${file}.asc`;
  rmSync(sig, { force: true });
  await downloadResumable(`${MYSQL8.base}/${name}.asc`, sig, io, 64 * 1024);
  const ring = `${file}.keyring`;
  writeFileSync(ring, keyring(), { mode: 0o600 });
  const verify = await ctx.exec(BIN.gpgv, ["--keyring", ring, sig, file], { allowFail: true, timeoutMs: 300_000 });
  rmSync(ring, { force: true });
  if (verify.code !== 0) {
    rmSync(file, { force: true });
    throw new ActionError("signature_mismatch", `${name} isn't signed by Oracle's MySQL key, so it wasn't used: ${verify.stderr.trim().split("\n").at(-1)}`);
  }
  io.emit("Oracle's signature checks out. Unpacking the server and its tools…\n");

  const target = join(MYSQL8.root, version);
  const tmp = `${target}.unpacking`;
  rmSync(tmp, { recursive: true, force: true });
  ensureDir(MYSQL8.root, 0o755);
  ensureDir(tmp, 0o755);
  const top = name.replace(/\.tar\.xz$/, "");
  const members = ["bin/mysqld", "bin/mysql", "bin/mysqldump", "bin/mysqladmin", "lib", "share"].map((m) => `${top}/${m}`);
  const untar = await ctx.exec(BIN.tar, ["--extract", "--xz", `--file=${file}`, `--directory=${tmp}`, "--strip-components=1", "--no-same-owner", "--exclude=*/lib/plugin/debug", "--exclude=*.a", ...members], { allowFail: true, timeoutMs: 1_200_000 });
  if (untar.code !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    throw new ActionError("install_failed", `unpacking MySQL failed: ${untar.stderr.trim().split("\n").at(-1)}`);
  }
  // Ubuntu 24.04 and later ship libaio as libaio.so.1t64; the build wants libaio.so.1.
  ensureDir(join(tmp, "lib", "compat"), 0o755);
  const multiarch = arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu";
  for (const lib of [`/usr/lib/${multiarch}/libaio.so.1t64`, `/lib/${multiarch}/libaio.so.1t64`]) {
    if (existsSync(lib) && !existsSync(`/usr/lib/${multiarch}/libaio.so.1`)) {
      symlinkSync(lib, join(tmp, "lib", "compat", "libaio.so.1"));
      break;
    }
  }
  await ctx.exec(BIN.chmod, ["-R", "go-w", tmp]);
  rmSync(target, { recursive: true, force: true });
  renameSync(tmp, target);
  // The big tarball isn't kept: an update downloads the new one.
  rmSync(file, { force: true });
  rmSync(sig, { force: true });

  if (!(await lookupUser(ctx.exec, MYSQL8.user))) {
    await ctx.exec(BIN.useradd, ["--system", "--user-group", "--shell", "/usr/sbin/nologin", "--home-dir", MYSQL8.datadir, "--no-create-home", MYSQL8.user]);
  }
  const user = (await lookupUser(ctx.exec, MYSQL8.user))!;
  const total = Math.round(totalmem() / 1048576);
  writeFileAtomic(MYSQL8.conf, renderMysql8Conf(version, true, total), 0o644);
  writeFileAtomic(join(ctx.paths.systemdDir, MYSQL8.unit), renderMysql8Unit(version), 0o644);

  const fresh = !existsSync(join(MYSQL8.datadir, "mysql.ibd"));
  if (fresh) {
    rmSync(MYSQL8.datadir, { recursive: true, force: true });
    ensureDir(MYSQL8.datadir, 0o750, { uid: user.uid, gid: user.gid });
    io.emit("Initializing its data folder…\n");
    const init = await ctx.exec(mysql8Bin(version, "mysqld"), [`--defaults-file=${MYSQL8.conf}`, "--initialize-insecure", `--user=${MYSQL8.user}`], { allowFail: true, timeoutMs: 600_000, env: { LD_LIBRARY_PATH: mysql8Compat(version) } });
    if (init.code !== 0) throw new ActionError("install_failed", `initializing MySQL 8 failed: ${init.stderr.trim().split("\n").slice(-2).join(" ")}`);
  }

  // First start with networking off: root has no password until the next line.
  await ctx.exec(BIN.systemctl, ["daemon-reload"]);
  await ctx.exec(BIN.systemctl, ["restart", MYSQL8.unit]);
  const password = randomBytes(24).toString("hex");
  await waitFor(ctx, fresh ? null : (mysql8StateRaw(ctx)?.password ?? null));
  if (fresh) await admin(ctx, `ALTER USER 'root'@'localhost' IDENTIFIED BY '${password}'; DROP DATABASE IF EXISTS test;`, { password: null });
  writeFileAtomic(stateFile(ctx), JSON.stringify({ version, password: fresh ? password : mysql8StateRaw(ctx)?.password }) + "\n", 0o600);

  // Now on 127.0.0.1:3307.
  writeFileAtomic(MYSQL8.conf, renderMysql8Conf(version, false, total), 0o644);
  await ctx.exec(BIN.systemctl, ["enable", MYSQL8.unit], { allowFail: true });
  await ctx.exec(BIN.systemctl, ["restart", MYSQL8.unit]);
  await waitFor(ctx, mysql8State(ctx)!.password);
  const v = (await admin(ctx, "SELECT VERSION()")).stdout.trim();
  return { name: "mysql8", installed: true, version: v, already: false };
}

/** The state file as written, even when the binaries are gone (a retry after a failed install). */
function mysql8StateRaw(ctx: Context): Mysql8State | null {
  try {
    return JSON.parse(readFileSync(stateFile(ctx), "utf8")) as Mysql8State;
  } catch {
    return null;
  }
}

/** A user and database for a site, over TCP from 127.0.0.1 only, its own database only. */
async function mysql8Add(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const app = appLayout(ctx, slug);
  if (!existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  if (!mysql8State(ctx)) throw new ActionError("not_installed", "MySQL 8 isn't installed yet (service.install mysql8)");
  const state = readServices(ctx, slug);
  const name = pgName(slug);
  const my = state.mysql8 ?? { database: name, user: name, password: randomBytes(24).toString("hex") };
  await admin(
    ctx,
    [
      `CREATE DATABASE IF NOT EXISTS ${my.database} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
      `CREATE USER IF NOT EXISTS '${my.user}'@'127.0.0.1' IDENTIFIED BY '${my.password}'`,
      `ALTER USER '${my.user}'@'127.0.0.1' IDENTIFIED BY '${my.password}' WITH MAX_USER_CONNECTIONS 20`,
      `GRANT ALL PRIVILEGES ON \`${grantPattern(my.database)}\`.* TO '${my.user}'@'127.0.0.1'`,
    ].join(";\n") + ";",
  );
  writeServices(ctx, slug, { ...state, mysql8: my });
  return { slug, database: my.database, user: my.user, host: "127.0.0.1", port: MYSQL8.port };
}

/** Drops a site's database and user (app.delete); with keepData its dump goes to the archive first. */
export async function removeMysql8(ctx: Context, slug: string, keepData = true): Promise<{ archived: string | null } | null> {
  const app = appLayout(ctx, slug);
  const state = existsSync(app.etcDir) ? readServices(ctx, slug) : {};
  const my = state.mysql8;
  const server = mysql8State(ctx);
  if (!my || !server) return null;
  let archived: string | null = null;
  if (keepData) {
    ensureDir(ctx.paths.archiveRoot, 0o700);
    archived = join(ctx.paths.archiveRoot, `${slug}-${new Date().toISOString().replace(/[:.]/g, "-")}.mysql8.sql`);
    // The password in the environment, never in arguments.
    const dump = await ctx.exec(mysql8Bin(server.version, "mysqldump"), ["--protocol=TCP", "--host=127.0.0.1", `--port=${MYSQL8.port}`, `--user=${my.user}`, "--single-transaction", "--quick", "--routines", "--no-tablespaces", `--result-file=${archived}`, my.database], { allowFail: true, timeoutMs: 1_800_000, env: { LD_LIBRARY_PATH: mysql8Compat(server.version), MYSQL_PWD: my.password } });
    if (dump.code !== 0) throw new ActionError("dump_failed", `couldn't dump ${my.database} before removing it: ${dump.stderr.trim().slice(0, 300)}`);
  }
  await admin(ctx, `DROP DATABASE IF EXISTS ${my.database}; DROP USER IF EXISTS '${my.user}'@'127.0.0.1';`);
  if (existsSync(app.etcDir)) {
    const { mysql8: _removed, ...rest } = state;
    writeServices(ctx, slug, rest);
  }
  return { archived };
}

async function mysql8Remove(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const keepData = params.keepData ?? true;
  if (typeof keepData !== "boolean") throw new ValidationError("keepData", "must be true or false");
  const result = await removeMysql8(ctx, slug, keepData);
  if (!result) throw new ActionError("not_found", `${slug} has no MySQL 8 database`);
  return { slug, removed: true, archived: result.archived };
}

async function mysql8Status(_params: Params, ctx: Context) {
  const s = mysql8State(ctx);
  if (!s) return { installed: false };
  const active = (await ctx.exec(BIN.systemctl, ["is-active", MYSQL8.unit], { allowFail: true })).stdout.trim() === "active";
  return { installed: true, version: s.version, active, port: MYSQL8.port };
}

export const mysql8Actions: ActionTable = {
  "mysql8.add": { mutates: true, run: mysql8Add },
  "mysql8.remove": { mutates: true, run: mysql8Remove },
  "mysql8.status": { mutates: false, run: mysql8Status },
};

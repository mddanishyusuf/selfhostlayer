// Databases next to apps, with credentials nobody else shares:
// - Redis: one small redis-server per app (its own port, password and memory
//   cap, data in the app's data/redis), as the app's user in its sandbox.
// - Postgres: one shared server, a role and database per app.
// The agent makes the passwords and writes them to services.env (root 600),
// which the app's units load before the user's app.env.
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { totalmem } from "node:os";
import { join } from "node:path";
import { assertInt, assertSlug, ValidationError } from "@layer/protocol";
import type { ActionTable, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { ensureDir, lookupUser, removeManaged, writeFileAtomic } from "../fsutil.ts";
import { isPortFree } from "../ports.ts";
import { SYSTEMD_RUN } from "../sandbox.ts";
import { renderEnvFile } from "../templates/env-file.ts";
import { redisUnit, renderRedisConf, renderRedisUnit } from "../templates/redis.ts";
import { appLayout } from "./app.ts";

export const REDIS_PORTS = { min: 6400, max: 6999 };
const REDIS_BINARIES = ["/usr/bin/redis-server", "/usr/bin/valkey-server"];

export interface ServicesState {
  redis?: { port: number; password: string; memoryMb: number };
  postgres?: { database: string; user: string; password: string };
}

const servicesFile = (ctx: Context, slug: string) => join(appLayout(ctx, slug).etcDir, "services.json");

export function readServices(ctx: Context, slug: string): ServicesState {
  const file = servicesFile(ctx, slug);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ServicesState) : {};
}

/** The env vars the app gets for its services. */
export function serviceEnv(state: ServicesState): Record<string, string> {
  const env: Record<string, string> = {};
  if (state.redis) env.REDIS_URL = `redis://default:${state.redis.password}@127.0.0.1:${state.redis.port}`;
  if (state.postgres) {
    const p = state.postgres;
    env.DATABASE_URL = `postgresql://${p.user}:${p.password}@127.0.0.1:5432/${p.database}`;
  }
  return env;
}

function writeServices(ctx: Context, slug: string, state: ServicesState): void {
  const app = appLayout(ctx, slug);
  writeFileAtomic(servicesFile(ctx, slug), JSON.stringify(state, null, 2) + "\n", 0o600);
  writeFileAtomic(join(app.etcDir, "services.env"), renderEnvFile(serviceEnv(state)), 0o600);
}

export function redisBinary(): string | null {
  return REDIS_BINARIES.find((b) => existsSync(b)) ?? null;
}

/**
 * apt-get in its own transient unit: the agent's sandbox keeps /usr read-only
 * (ProtectSystem=yes), and package installs need to write there.
 */
function apt(ctx: Context, args: string[], unit: string) {
  return ctx.exec(
    SYSTEMD_RUN,
    ["--quiet", "--wait", "--pipe", "--collect", `--unit=${unit}`, "--setenv=DEBIAN_FRONTEND=noninteractive", "--setenv=NEEDRESTART_MODE=a", "--", BIN.aptGet, ...args],
    { timeoutMs: 600_000, allowFail: true },
  );
}

async function serviceInstall(params: Params, ctx: Context) {
  const name = params.name;
  if (name === "postgres") return installPostgres(ctx);
  if (name !== "redis") throw new ValidationError("name", 'must be "redis" or "postgres"');
  if (redisBinary()) return { name, installed: true, binary: redisBinary(), already: true };
  await apt(ctx, ["update", "-q"], "layer-apt-update");
  // Some releases ship Valkey (the Redis fork) instead of Redis; both work the same here.
  let ok = false;
  for (const pkg of ["redis-server", "valkey-server"]) {
    const r = await apt(ctx, ["install", "-y", "-q", "--no-install-recommends", pkg], "layer-apt-install");
    if (r.code === 0) {
      ok = true;
      break;
    }
  }
  const binary = redisBinary();
  if (!ok || !binary) throw new ActionError("install_failed", "couldn't install redis-server or valkey-server with apt");
  // The package's own shared instance stays off: every app gets its own.
  for (const unit of ["redis-server.service", "valkey-server.service"]) {
    await ctx.exec(BIN.systemctl, ["disable", "--now", unit], { allowFail: true });
    await ctx.exec(BIN.systemctl, ["mask", unit], { allowFail: true });
  }
  return { name, installed: true, binary, already: false };
}

function usedRedisPorts(ctx: Context): Set<number> {
  const used = new Set<number>();
  if (!existsSync(ctx.paths.appEtcRoot)) return used;
  for (const slug of readdirSync(ctx.paths.appEtcRoot)) {
    try {
      const port = readServices(ctx, slug).redis?.port;
      if (port) used.add(port);
    } catch {
      // unreadable file: skip
    }
  }
  return used;
}

/** AUTH + PING over a plain socket: proves the instance is up and the password works. */
export function redisPing(port: number, password: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let data = "";
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on("error", () => done(false));
    socket.on("connect", () => socket.write(`AUTH ${password}\r\nPING\r\n`));
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("+PONG")) done(data.startsWith("+OK"));
      else if (data.startsWith("-")) done(false);
    });
  });
}

async function waitForRedis(port: number, password: string): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (await redisPing(port, password)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function redisAdd(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const memoryMb = assertInt(params.memoryMb ?? 64, "memoryMb", 16, 4096);
  const app = appLayout(ctx, slug);
  const user = await lookupUser(ctx.exec, app.user);
  if (!user || !existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  const binary = redisBinary();
  if (!binary) throw new ActionError("not_installed", "Redis isn't installed yet (service.install redis)");

  const state = readServices(ctx, slug);
  let redis = state.redis;
  if (!redis) {
    const used = usedRedisPorts(ctx);
    let port = 0;
    for (let p = REDIS_PORTS.min; p <= REDIS_PORTS.max; p++) {
      if (!used.has(p) && (await isPortFree(p))) {
        port = p;
        break;
      }
    }
    if (!port) throw new ActionError("no_ports", `no free ports left in ${REDIS_PORTS.min}-${REDIS_PORTS.max}`);
    redis = { port, password: randomBytes(24).toString("hex"), memoryMb };
  } else {
    redis = { ...redis, memoryMb };
  }
  const input = { slug, binary, ...redis };
  ensureDir(join(app.data, "redis"), 0o700, { uid: user.uid, gid: user.gid });
  writeFileAtomic(join(app.etcDir, "redis.conf"), renderRedisConf(input), 0o600);
  writeFileAtomic(join(ctx.paths.systemdDir, redisUnit(slug)), renderRedisUnit(input), 0o644);
  writeServices(ctx, slug, { ...state, redis });
  await ctx.exec(BIN.systemctl, ["daemon-reload"]);
  await ctx.exec(BIN.systemctl, ["enable", redisUnit(slug)]);
  await ctx.exec(BIN.systemctl, ["restart", redisUnit(slug)]);
  if (!(await waitForRedis(redis.port, redis.password))) {
    const { stdout } = await ctx.exec(BIN.journalctl, ["--no-pager", "-n", "20", "-u", redisUnit(slug)], { allowFail: true });
    throw new ActionError("start_failed", `Redis for ${slug} didn't answer on port ${redis.port}:\n${stdout.trim().split("\n").slice(-8).join("\n")}`);
  }
  return { slug, port: redis.port, memoryMb: redis.memoryMb, env: ["REDIS_URL"] };
}

/** Stops and removes the app's Redis. Its data stays in data/redis unless keepData is false. */
export async function removeRedis(ctx: Context, slug: string, keepData = true): Promise<boolean> {
  const app = appLayout(ctx, slug);
  const unitFile = join(ctx.paths.systemdDir, redisUnit(slug));
  const state = existsSync(app.etcDir) ? readServices(ctx, slug) : {};
  if (!existsSync(unitFile) && !state.redis) return false;
  await ctx.exec(BIN.systemctl, ["disable", "--now", redisUnit(slug)], { allowFail: true });
  removeManaged(unitFile);
  await ctx.exec(BIN.systemctl, ["daemon-reload"]);
  await ctx.exec(BIN.systemctl, ["reset-failed", redisUnit(slug)], { allowFail: true });
  removeManaged(join(app.etcDir, "redis.conf"));
  if (existsSync(app.etcDir)) {
    const { redis: _removed, ...rest } = state;
    writeServices(ctx, slug, rest);
  }
  if (!keepData) rmSync(join(app.data, "redis"), { recursive: true, force: true });
  return true;
}

async function redisRemove(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const keepData = params.keepData ?? true;
  if (typeof keepData !== "boolean") throw new ValidationError("keepData", "must be true or false");
  if (!(await removeRedis(ctx, slug, keepData))) throw new ActionError("not_found", `${slug} has no Redis`);
  return { slug, removed: true, keptData: keepData };
}

async function serviceStatus(params: Params, ctx: Context) {
  // Without an app: just which engines are installed on the server.
  if (params.slug === undefined) return { installed: { redis: redisBinary() !== null, postgres: postgresCluster() !== null } };
  const slug = assertSlug(params.slug);
  const app = appLayout(ctx, slug);
  if (!existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  const state = readServices(ctx, slug);
  const env = serviceEnv(state);
  const out: Record<string, unknown> = { slug, installed: { redis: redisBinary() !== null, postgres: postgresCluster() !== null } };
  if (state.postgres && postgresCluster()) {
    const size = await psql(ctx, `SELECT pg_database_size('${state.postgres.database}')`, { allowFail: true });
    out.postgres = {
      database: state.postgres.database,
      url: env.DATABASE_URL,
      sizeMb: size.code === 0 ? Math.round((Number(size.stdout.trim()) / 1048576) * 10) / 10 : null,
      answering: size.code === 0,
    };
  }
  if (state.redis) {
    const { stdout } = await ctx.exec(BIN.systemctl, ["show", redisUnit(slug), "-pActiveState", "-pMemoryCurrent"], { allowFail: true });
    const props = Object.fromEntries(stdout.trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
    const memory = Number(props.MemoryCurrent);
    out.redis = {
      port: state.redis.port,
      memoryMb: state.redis.memoryMb,
      url: env.REDIS_URL,
      active: props.ActiveState === "active",
      memoryUsedMb: Number.isFinite(memory) ? Math.round(memory / 1048576) : null,
      answering: await redisPing(state.redis.port, state.redis.password, 1000),
    };
  }
  return out;
}

// ---------------------------------------------------------------- Postgres

const PG_CONF_DIR = "/etc/postgresql";

/** The installed cluster's config folder, e.g. /etc/postgresql/16/main. */
export function postgresCluster(): { version: string; dir: string } | null {
  if (!existsSync(PG_CONF_DIR) || !existsSync(BIN.psql)) return null;
  const version = readdirSync(PG_CONF_DIR)
    .filter((v) => /^\d+$/.test(v) && existsSync(join(PG_CONF_DIR, v, "main")))
    .sort((a, b) => Number(b) - Number(a))[0];
  return version ? { version, dir: join(PG_CONF_DIR, version, "main") } : null;
}

/** Settings for a small box: modest memory, localhost only, SCRAM passwords. */
export function renderPostgresConf(totalMb: number): string {
  const shared = Math.min(512, Math.max(32, Math.floor(totalMb / 16)));
  return `# Generated by layer-agent: Postgres tuned for a small server.
listen_addresses = '127.0.0.1'
password_encryption = scram-sha-256
max_connections = 50
shared_buffers = ${shared}MB
effective_cache_size = ${Math.max(128, Math.floor(totalMb / 4))}MB
work_mem = 4MB
maintenance_work_mem = ${Math.min(256, Math.max(32, Math.floor(totalMb / 32)))}MB
`;
}

async function installPostgres(ctx: Context) {
  let cluster = postgresCluster();
  const already = cluster !== null;
  if (!cluster) {
    await apt(ctx, ["update", "-q"], "layer-apt-update");
    const r = await apt(ctx, ["install", "-y", "-q", "--no-install-recommends", "postgresql"], "layer-apt-install");
    cluster = postgresCluster();
    if (r.code !== 0 || !cluster) throw new ActionError("install_failed", `couldn't install postgresql with apt: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
  }
  ensureDir(join(cluster.dir, "conf.d"), 0o755);
  writeFileAtomic(join(cluster.dir, "conf.d", "layer.conf"), renderPostgresConf(Math.round(totalmem() / 1048576)), 0o644);
  await ctx.exec(BIN.systemctl, ["enable", "postgresql"], { allowFail: true });
  await ctx.exec(BIN.systemctl, ["restart", "postgresql"]);
  await waitForPostgres(ctx);
  return { name: "postgres", installed: true, version: cluster.version, already };
}

/** Runs SQL as the postgres superuser (peer auth over the local socket). Returns rows as text. */
async function psql(ctx: Context, sql: string, opts: { allowFail?: boolean } = {}) {
  return ctx.exec(BIN.runuser, ["-u", "postgres", "--", BIN.psql, "-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-c", sql], { allowFail: opts.allowFail, timeoutMs: 120_000 });
}

async function waitForPostgres(ctx: Context): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if ((await psql(ctx, "SELECT 1", { allowFail: true })).code === 0) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new ActionError("start_failed", "Postgres didn't come up");
}

/** app_<slug>, with dashes as underscores: a plain identifier, no quoting needed. */
export const pgName = (slug: string) => `app_${assertSlug(slug).replaceAll("-", "_")}`;

async function postgresAdd(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const app = appLayout(ctx, slug);
  if (!existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  if (!postgresCluster()) throw new ActionError("not_installed", "Postgres isn't installed yet (service.install postgres)");
  const state = readServices(ctx, slug);
  const name = pgName(slug);
  const pg = state.postgres ?? { database: name, user: name, password: randomBytes(24).toString("hex") };
  // Names are app_[a-z0-9_]+ and the password is hex: nothing here needs escaping.
  const role = (await psql(ctx, `SELECT 1 FROM pg_roles WHERE rolname = '${pg.user}'`)).stdout.trim();
  await psql(ctx, `${role ? "ALTER" : "CREATE"} ROLE ${pg.user} LOGIN PASSWORD '${pg.password}' CONNECTION LIMIT 20`);
  const db = (await psql(ctx, `SELECT 1 FROM pg_database WHERE datname = '${pg.database}'`)).stdout.trim();
  if (!db) await psql(ctx, `CREATE DATABASE ${pg.database} OWNER ${pg.user}`);
  // Only its owner (and the superuser) may connect: no other app's role can.
  await psql(ctx, `REVOKE ALL ON DATABASE ${pg.database} FROM PUBLIC`);
  writeServices(ctx, slug, { ...state, postgres: pg });
  // Prove the credentials the app gets work, over TCP like the app connects.
  const check = await ctx.exec(BIN.runuser, ["-u", "postgres", "--", BIN.psql, "-X", "-tA", "-c", "SELECT current_user", serviceEnv({ postgres: pg }).DATABASE_URL!], { allowFail: true });
  if (check.code !== 0 || check.stdout.trim() !== pg.user) throw new ActionError("start_failed", `the new credentials don't work: ${check.stderr.trim()}`);
  return { slug, database: pg.database, env: ["DATABASE_URL"] };
}

/** Drops the app's database and role. With keepData, a pg_dump goes to the archive first. */
export async function removePostgres(ctx: Context, slug: string, keepData = true): Promise<{ archived: string | null } | null> {
  const app = appLayout(ctx, slug);
  const state = existsSync(app.etcDir) ? readServices(ctx, slug) : {};
  const pg = state.postgres;
  if (!pg || !postgresCluster()) return null;
  let archived: string | null = null;
  if (keepData) {
    ensureDir(ctx.paths.archiveRoot, 0o700);
    archived = join(ctx.paths.archiveRoot, `${slug}-${new Date().toISOString().replace(/[:.]/g, "-")}.pgdump`);
    // pg_dump runs as postgres and writes to stdout: a file only root can read.
    const fd = openSync(archived, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    let errors = "";
    let code: number;
    try {
      ({ code } = await ctx.spawn(BIN.runuser, ["-u", "postgres", "--", BIN.pgDump, "--format=custom", pg.database], { stdout: fd, onData: (c) => (errors += c) }));
    } finally {
      closeSync(fd);
    }
    if (code !== 0) {
      rmSync(archived, { force: true });
      throw new ActionError("dump_failed", `couldn't dump ${pg.database} before removing it: ${errors.trim().slice(0, 300)}`);
    }
  }
  await psql(ctx, `DROP DATABASE IF EXISTS ${pg.database} WITH (FORCE)`);
  await psql(ctx, `DROP ROLE IF EXISTS ${pg.user}`);
  if (existsSync(app.etcDir)) {
    const { postgres: _removed, ...rest } = state;
    writeServices(ctx, slug, rest);
  }
  return { archived };
}

async function postgresRemove(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const keepData = params.keepData ?? true;
  if (typeof keepData !== "boolean") throw new ValidationError("keepData", "must be true or false");
  const result = await removePostgres(ctx, slug, keepData);
  if (!result) throw new ActionError("not_found", `${slug} has no Postgres`);
  return { slug, removed: true, archived: result.archived };
}

export const serviceActions: ActionTable = {
  "service.install": { mutates: true, run: serviceInstall },
  "service.status": { mutates: false, run: serviceStatus },
  "redis.add": { mutates: true, run: redisAdd },
  "redis.remove": { mutates: true, run: redisRemove },
  "postgres.add": { mutates: true, run: postgresAdd },
  "postgres.remove": { mutates: true, run: postgresRemove },
};

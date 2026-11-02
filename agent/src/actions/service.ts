// Databases next to apps, with credentials nobody else shares:
// - Redis: one small redis-server per app (its own port, password and memory
//   cap, data in the app's data/redis), as the app's user in its sandbox.
// - Postgres: one shared server, a role and database per app.
// - MySQL (MariaDB): the same, a user and database per app. An app gets one
//   SQL database, Postgres or MySQL, since both hand it DATABASE_URL.
// - MongoDB: one shared server from MongoDB's own repository, a user and
//   database per app, handed over as MONGODB_URI (so next to SQL is fine).
// The agent makes the passwords and writes them to services.env (root 600),
// which the app's units load before the user's app.env.
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { assertInt, assertSlug, ValidationError } from "@layer/protocol";
import type { ActionTable, CallIO, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { ensureDir, lookupUser, removeManaged, writeFileAtomic } from "../fsutil.ts";
import { isPortFree } from "../ports.ts";
import { SYSTEMD_RUN } from "../sandbox.ts";
import { renderEnvFile } from "../templates/env-file.ts";
import { MONGOD_CONF, MONGODB_KEYRING, MONGODB_SERIES, MONGODB_SIGNING_KEY, MONGODB_SOURCES, MONGOSH_CONF, mongodbSource, renderMongodConf, renderMongodDropin, renderMongoshConf } from "../templates/mongodb.ts";
import { redisUnit, renderRedisConf, renderRedisUnit } from "../templates/redis.ts";
import { appLayout } from "./app.ts";
import { MYSQL8 } from "../templates/mysql8.ts";
import { installMysql8 } from "./mysql8.ts";
import { installPhp } from "./php.ts";

export const REDIS_PORTS = { min: 6400, max: 6999 };
const REDIS_BINARIES = ["/usr/bin/redis-server", "/usr/bin/valkey-server"];

export interface ServicesState {
  redis?: { port: number; password: string; memoryMb: number };
  postgres?: { database: string; user: string; password: string };
  mysql?: { database: string; user: string; password: string };
  mongodb?: { database: string; user: string; password: string };
  /** MySQL 8 (Oracle's), for Ghost sites: Ghost supports no other database in production. */
  mysql8?: { database: string; user: string; password: string };
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
  if (state.mysql) {
    const m = state.mysql;
    env.DATABASE_URL = `mysql://${m.user}:${m.password}@127.0.0.1:3306/${m.database}`;
  }
  // The user lives in the app's own database, so the URL needs no authSource.
  if (state.mongodb) {
    const m = state.mongodb;
    env.MONGODB_URI = `mongodb://${m.user}:${m.password}@127.0.0.1:27017/${m.database}`;
  }
  // Ghost reads its config from env vars, nconf style (database__connection__host).
  if (state.mysql8) {
    const m = state.mysql8;
    Object.assign(env, {
      database__client: "mysql",
      database__connection__host: "127.0.0.1",
      database__connection__port: "3307",
      database__connection__user: m.user,
      database__connection__password: m.password,
      database__connection__database: m.database,
      // Where its tools are, for backups (not a secret).
      LAYER_MYSQL8_HOME: `${MYSQL8.root}/${MYSQL8.version}`,
    });
  }
  return env;
}

export function writeServices(ctx: Context, slug: string, state: ServicesState): void {
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

async function serviceInstall(params: Params, ctx: Context, io: CallIO) {
  const name = params.name;
  if (name === "postgres") return installPostgres(ctx);
  if (name === "mysql") return installMysql(ctx);
  if (name === "mongodb") return installMongodb(ctx);
  if (name === "php") return installPhp(ctx);
  if (name === "mysql8") return installMysql8(ctx, io);
  if (name !== "redis") throw new ValidationError("name", 'must be "redis", "postgres", "mysql", "mongodb", "php" or "mysql8"');
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

/** How many keys an app's Redis holds (DBSIZE), or null when it doesn't answer. */
export function redisKeys(port: number, password: string, timeoutMs = 1000): Promise<number | null> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let data = "";
    const done = (keys: number | null) => {
      socket.destroy();
      resolve(keys);
    };
    socket.setTimeout(timeoutMs, () => done(null));
    socket.on("error", () => done(null));
    socket.on("connect", () => socket.write(`AUTH ${password}\r\nDBSIZE\r\n`));
    socket.on("data", (chunk) => {
      data += chunk.toString();
      const reply = /^\+OK\r\n:(\d+)\r\n/.exec(data);
      if (reply) done(Number(reply[1]));
      else if (data.startsWith("-") || data.includes("\r\n-")) done(null);
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

/** Whether systemd says each shared database server is up. */
async function serversRunning(ctx: Context): Promise<{ postgres: boolean; mysql: boolean; mongodb: boolean }> {
  const pg = postgresCluster();
  const { stdout } = await ctx.exec(BIN.systemctl, ["is-active", pg ? `postgresql@${pg.version}-main` : "postgresql", "mariadb", "mongod"], { allowFail: true });
  const [postgres, mysql, mongodb] = stdout.split("\n").map((state) => state.trim() === "active");
  return { postgres: postgres ?? false, mysql: mysql ?? false, mongodb: mongodb ?? false };
}

async function serviceStatus(params: Params, ctx: Context) {
  // Without an app: just which engines are installed on the server, and whether their servers are up.
  const installed = { redis: redisBinary() !== null, postgres: postgresCluster() !== null, mysql: mysqlInstalled(), mongodb: mongodbInstalled(ctx) };
  const running = await serversRunning(ctx);
  if (params.slug === undefined) return { installed, running, versions: await engineVersions(ctx, installed.mongodb) };
  const slug = assertSlug(params.slug);
  const app = appLayout(ctx, slug);
  if (!existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  const state = readServices(ctx, slug);
  const env = serviceEnv(state);
  const out: Record<string, unknown> = { slug, installed, running };
  if (state.postgres && postgresCluster()) {
    // In the app's own database: its size and its tables.
    const r = await psql(ctx, "SELECT pg_database_size(current_database()), (SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema'))", { allowFail: true, database: state.postgres.database });
    const [bytes, tables] = r.stdout.trim().split("|").map(Number);
    out.postgres = {
      database: state.postgres.database,
      url: env.DATABASE_URL,
      sizeMb: r.code === 0 ? megabytes(bytes) : null,
      tables: r.code === 0 && Number.isInteger(tables) ? tables : null,
      answering: r.code === 0,
    };
  }
  if (state.mysql && installed.mysql) {
    const r = await mysql(ctx, `SELECT COALESCE(SUM(data_length + index_length), 0), COUNT(*) FROM information_schema.tables WHERE table_schema = '${state.mysql.database}'`, { allowFail: true });
    const [bytes, tables] = r.stdout.trim().split("\t").map(Number);
    out.mysql = {
      database: state.mysql.database,
      url: env.DATABASE_URL,
      sizeMb: r.code === 0 ? megabytes(bytes) : null,
      tables: r.code === 0 && Number.isInteger(tables) ? tables : null,
      answering: r.code === 0,
    };
  }
  if (state.mongodb && installed.mongodb) {
    // dbStats sends some counts as 64-bit integers (Long objects in mongosh): Number() makes them plain.
    const r = await mongosh(ctx, `const s = db.getSiblingDB(${q(state.mongodb.database)}).runCommand({ dbStats: 1 }); print(JSON.stringify({ bytes: Number(s.totalSize ?? Number(s.storageSize) + Number(s.indexSize)), collections: Number(s.collections) }))`, { allowFail: true }).catch(() => null);
    const stats = (r?.code === 0 ? lastJson(r.stdout) : null) as { bytes?: unknown; collections?: unknown } | null;
    const bytes = typeof stats?.bytes === "number" ? stats.bytes : null;
    out.mongodb = {
      database: state.mongodb.database,
      url: env.MONGODB_URI,
      sizeMb: bytes === null ? null : megabytes(bytes),
      collections: typeof stats?.collections === "number" ? stats.collections : null,
      answering: bytes !== null,
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
      ...(await redisKeys(state.redis.port, state.redis.password).then((keys) => ({ keys, answering: keys !== null }))),
    };
  }
  return out;
}

const megabytes = (bytes: number | undefined) => Math.round(((bytes ?? 0) / 1048576) * 10) / 10;

/** The engines' versions for the Databases page: Postgres's cluster, Redis's server, the MongoDB series this agent installs. */
async function engineVersions(ctx: Context, mongodb: boolean) {
  const redis = redisBinary();
  const r = redis ? await ctx.exec(redis, ["--version"], { allowFail: true }) : null;
  return {
    postgres: postgresCluster()?.version ?? null,
    redis: r?.code === 0 ? (/v=(\d+\.\d+)/.exec(r.stdout)?.[1] ?? null) : null,
    mongodb: mongodb ? MONGODB_SERIES : null,
  };
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

/** Runs SQL as the postgres superuser (peer auth over the local socket), in the postgres database or the one named. Returns rows as text. */
// SQL goes on stdin: a role's password in an argument would show in the
// process list for a moment, and in the error if the command failed.
async function psql(ctx: Context, sql: string, opts: { allowFail?: boolean; database?: string } = {}) {
  return ctx.exec(BIN.runuser, ["-u", "postgres", "--", BIN.psql, "-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", ...(opts.database ? ["-d", opts.database] : [])], { allowFail: opts.allowFail, timeoutMs: 120_000, input: sql });
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
  const state = readServices(ctx, slug);
  if (state.mysql) throw new ActionError("conflict", `${slug} already has MySQL: an app gets one SQL database, since both use DATABASE_URL`);
  if (!postgresCluster()) throw new ActionError("not_installed", "Postgres isn't installed yet (service.install postgres)");
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
  const check = await ctx.exec(BIN.runuser, ["-u", "postgres", "--", BIN.psql, "-X", "-tA", "-c", "SELECT current_user", `postgresql://${pg.user}@127.0.0.1:5432/${pg.database}`], { allowFail: true, env: { PGPASSWORD: pg.password } });
  if (check.code !== 0 || check.stdout.trim() !== pg.user) throw new ActionError("start_failed", `the new credentials don't work: ${check.stderr.trim()}`);
  return { slug, database: pg.database, env: ["DATABASE_URL"] };
}

/** Drops the app's database and role. With keepData, a pg_dump goes to the archive first. */
export async function removePostgres(ctx: Context, slug: string, keepData = true): Promise<{ archived: string | null } | null> {
  const app = appLayout(ctx, slug);
  const state = existsSync(app.etcDir) ? readServices(ctx, slug) : {};
  const pg = state.postgres;
  if (!pg || !postgresCluster()) return null;
  // pg_dump runs as postgres and writes to stdout.
  const archived = keepData ? await archiveDump(ctx, slug, "pgdump", BIN.runuser, ["-u", "postgres", "--", BIN.pgDump, "--format=custom", pg.database], pg.database) : null;
  await psql(ctx, `DROP DATABASE IF EXISTS ${pg.database} WITH (FORCE)`);
  await psql(ctx, `DROP ROLE IF EXISTS ${pg.user}`);
  if (existsSync(app.etcDir)) {
    const { postgres: _removed, ...rest } = state;
    writeServices(ctx, slug, rest);
  }
  return { archived };
}

/** Runs a dump command into a new file in the archive, one only root can read. Returns its path. */
async function archiveDump(ctx: Context, slug: string, ext: string, file: string, args: string[], what: string): Promise<string> {
  ensureDir(ctx.paths.archiveRoot, 0o700);
  const archived = join(ctx.paths.archiveRoot, `${slug}-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`);
  const fd = openSync(archived, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let errors = "";
  let code: number;
  try {
    ({ code } = await ctx.spawn(file, args, { stdout: fd, onData: (c) => (errors += c) }));
  } finally {
    closeSync(fd);
  }
  if (code !== 0) {
    rmSync(archived, { force: true });
    throw new ActionError("dump_failed", `couldn't dump ${what} before removing it: ${errors.trim().slice(0, 300)}`);
  }
  return archived;
}

async function postgresRemove(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const keepData = params.keepData ?? true;
  if (typeof keepData !== "boolean") throw new ValidationError("keepData", "must be true or false");
  const result = await removePostgres(ctx, slug, keepData);
  if (!result) throw new ActionError("not_found", `${slug} has no Postgres`);
  return { slug, removed: true, archived: result.archived };
}

// ---------------------------------------------------------------- MySQL (MariaDB)

const MARIADB_SERVER = "/usr/sbin/mariadbd";
const MARIADB_CONF = "/etc/mysql/mariadb.conf.d/90-layer.cnf";

export function mysqlInstalled(): boolean {
  return existsSync(MARIADB_SERVER) && existsSync(BIN.mariadb);
}

/** Settings for a small box, like Postgres's: modest memory, localhost only. */
export function renderMariadbConf(totalMb: number): string {
  return `# Generated by layer-agent: MariaDB tuned for a small server.
[mysqld]
bind-address = 127.0.0.1
skip-name-resolve
max_connections = 50
innodb_buffer_pool_size = ${Math.min(512, Math.max(32, Math.floor(totalMb / 16)))}M
key_buffer_size = 8M
performance_schema = OFF
character-set-server = utf8mb4
collation-server = utf8mb4_unicode_ci
`;
}

/** Runs SQL as root over the local socket (MariaDB's unix_socket login). Returns rows as text. */
// On stdin, as for psql: passwords stay out of the process list.
async function mysql(ctx: Context, sql: string, opts: { allowFail?: boolean } = {}) {
  return ctx.exec(BIN.mariadb, ["--batch", "--skip-column-names"], { allowFail: opts.allowFail, timeoutMs: 120_000, input: sql });
}

async function waitForMysql(ctx: Context): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if ((await mysql(ctx, "SELECT 1", { allowFail: true })).code === 0) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new ActionError("start_failed", "MariaDB didn't come up");
}

async function installMysql(ctx: Context) {
  const already = mysqlInstalled();
  if (!already) {
    await apt(ctx, ["update", "-q"], "layer-apt-update");
    const r = await apt(ctx, ["install", "-y", "-q", "--no-install-recommends", "mariadb-server"], "layer-apt-install");
    if (r.code !== 0 || !mysqlInstalled()) throw new ActionError("install_failed", `couldn't install mariadb-server with apt: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
  }
  writeFileAtomic(MARIADB_CONF, renderMariadbConf(Math.round(totalmem() / 1048576)), 0o644);
  await ctx.exec(BIN.systemctl, ["enable", "mariadb"], { allowFail: true });
  await ctx.exec(BIN.systemctl, ["restart", "mariadb"]);
  await waitForMysql(ctx);
  // Older packages came with anonymous logins and a test database anyone could use.
  await mysql(ctx, "DROP USER IF EXISTS ''@'localhost'; DROP USER IF EXISTS ''@'%'; DROP DATABASE IF EXISTS test");
  const version = (await mysql(ctx, "SELECT VERSION()")).stdout.trim();
  return { name: "mysql", installed: true, version, already };
}

/**
 * The database name as a GRANT pattern. In grants, _ matches any character:
 * unescaped, app_my_app would also cover the database of an app called myxapp.
 */
export const grantPattern = (database: string) => database.replaceAll("_", "\\_");

async function mysqlAdd(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const app = appLayout(ctx, slug);
  if (!existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  const state = readServices(ctx, slug);
  if (state.postgres) throw new ActionError("conflict", `${slug} already has Postgres: an app gets one SQL database, since both use DATABASE_URL`);
  if (!mysqlInstalled()) throw new ActionError("not_installed", "MySQL isn't installed yet (service.install mysql)");
  const name = pgName(slug);
  const my = state.mysql ?? { database: name, user: name, password: randomBytes(24).toString("hex") };
  // Names are app_[a-z0-9_]+ and the password is hex: nothing here needs escaping
  // beyond the grant's pattern. The user can only log in over TCP from 127.0.0.1.
  await mysql(
    ctx,
    [
      `CREATE DATABASE IF NOT EXISTS ${my.database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      `CREATE USER IF NOT EXISTS '${my.user}'@'127.0.0.1' IDENTIFIED BY '${my.password}'`,
      `ALTER USER '${my.user}'@'127.0.0.1' IDENTIFIED BY '${my.password}' WITH MAX_USER_CONNECTIONS 20`,
      `GRANT ALL PRIVILEGES ON \`${grantPattern(my.database)}\`.* TO '${my.user}'@'127.0.0.1'`,
    ].join("; "),
  );
  writeServices(ctx, slug, { ...state, mysql: my });
  // Prove the credentials the app gets work, over TCP like the app connects.
  const check = await ctx.exec(BIN.mariadb, ["--protocol=TCP", "--host=127.0.0.1", "--port=3306", `--user=${my.user}`, "--batch", "--skip-column-names", "--execute", "SELECT CURRENT_USER()", my.database], {
    allowFail: true,
    env: { MYSQL_PWD: my.password },
  });
  if (check.code !== 0 || check.stdout.trim() !== `${my.user}@127.0.0.1`) throw new ActionError("start_failed", `the new credentials don't work: ${check.stderr.trim()}`);
  return { slug, database: my.database, env: ["DATABASE_URL"] };
}

/** Drops the app's database and user. With keepData, a dump goes to the archive first. */
export async function removeMysql(ctx: Context, slug: string, keepData = true): Promise<{ archived: string | null } | null> {
  const app = appLayout(ctx, slug);
  const state = existsSync(app.etcDir) ? readServices(ctx, slug) : {};
  const my = state.mysql;
  if (!my || !mysqlInstalled()) return null;
  const archived = keepData ? await archiveDump(ctx, slug, "sql", BIN.mariadbDump, ["--single-transaction", "--quick", "--routines", "--events", my.database], my.database) : null;
  await mysql(ctx, `DROP DATABASE IF EXISTS ${my.database}; DROP USER IF EXISTS '${my.user}'@'127.0.0.1'`);
  if (existsSync(app.etcDir)) {
    const { mysql: _removed, ...rest } = state;
    writeServices(ctx, slug, rest);
  }
  return { archived };
}

async function mysqlRemove(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const keepData = params.keepData ?? true;
  if (typeof keepData !== "boolean") throw new ValidationError("keepData", "must be true or false");
  const result = await removeMysql(ctx, slug, keepData);
  if (!result) throw new ActionError("not_found", `${slug} has no MySQL`);
  return { slug, removed: true, archived: result.archived };
}

// ---------------------------------------------------------------- MongoDB

/** MongoDB's packages are on the server. */
function mongodbPackages(): boolean {
  return existsSync(BIN.mongod) && existsSync(BIN.mongosh);
}

/** Installed and set up: the packages, and the agent's login, which the install makes once mongod answers. */
export function mongodbInstalled(ctx: Context): boolean {
  return mongodbPackages() && existsSync(ctx.paths.mongodbAdmin);
}

/** /etc/os-release's ID and VERSION_CODENAME, which pick MongoDB's apt source. */
function osRelease(): { id: string; codename: string } {
  const text = existsSync("/etc/os-release") ? readFileSync("/etc/os-release", "utf8") : "";
  const field = (key: string) => new RegExp(`^${key}="?([^"\\n]*)"?$`, "m").exec(text)?.[1] ?? "";
  return { id: field("ID"), codename: field("VERSION_CODENAME") };
}

interface MongoLogin {
  user: string;
  password: string;
}

function readMongoAdmin(ctx: Context): MongoLogin | null {
  return existsSync(ctx.paths.mongodbAdmin) ? (JSON.parse(readFileSync(ctx.paths.mongodbAdmin, "utf8")) as MongoLogin) : null;
}

/** Names are app_[a-z0-9_]+ and passwords hex: a JSON string is all the quoting a script needs. */
const q = (s: string) => JSON.stringify(s);

/** A connection that gives up after 5 s when nothing answers, instead of the driver's 30. */
const quick = (url: string) => `${url}${url.includes("?") ? "&" : "?"}serverSelectionTimeoutMS=5000`;

/**
 * Runs a mongosh script logged in as the agent (by default), as the login in
 * `url`, or with none. The script, and the password in it, go through a file
 * only root can read: never the process list.
 */
async function mongosh(ctx: Context, body: string, opts: { as?: "agent" | "nobody" | { url: string }; allowFail?: boolean } = {}) {
  const as = opts.as ?? "agent";
  let url = "mongodb://127.0.0.1:27017/admin";
  if (as === "agent") {
    const admin = readMongoAdmin(ctx);
    if (!admin) throw new ActionError("not_installed", "MongoDB has no login for the agent yet (service.install mongodb)");
    url = `mongodb://${admin.user}:${admin.password}@127.0.0.1:27017/admin`;
  } else if (as !== "nobody") {
    url = as.url;
  }
  const dir = mkdtempSync(join(tmpdir(), "layer-mongosh-"));
  try {
    const script = join(dir, "script.js");
    writeFileSync(script, `db = connect(${q(quick(url))});\n${body}\n`, { mode: 0o600 });
    // HOME for mongosh's own log files, in the folder that goes away after.
    return await ctx.exec(BIN.mongosh, ["--quiet", "--norc", "--nodb", script], { allowFail: opts.allowFail, timeoutMs: 120_000, env: { HOME: dir } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The last line of output that parses as JSON: scripts end with print(JSON.stringify(…)). */
function lastJson(stdout: string): unknown {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // a log line: keep looking
    }
  }
  return null;
}

/** Lines about how mongod aborts, which come after the one that says why. */
const MONGOD_ABORTING = /^(Writing fatal message|\s*\*\*\*aborting)/;

/**
 * Why mongod stopped, from its log (one JSON object a line): the last fatal or
 * error line that says why, with the error it carries.
 */
export function mongodFailure(log: string): string | null {
  let why: string | null = null;
  for (const line of log.split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry: { s?: string; msg?: unknown; attr?: { error?: unknown; message?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // not one of mongod's lines
    }
    if ((entry.s !== "F" && entry.s !== "E") || typeof entry.msg !== "string" || MONGOD_ABORTING.test(entry.msg)) continue;
    // The error comes as a string, as { errmsg }, or from WiredTiger as message.error_str.
    const { error, message } = entry.attr ?? {};
    const detail = [error, (error as { errmsg?: unknown } | null)?.errmsg, (message as { error_str?: unknown } | null)?.error_str].find((d) => typeof d === "string");
    if (!detail && entry.msg === "Fatal assertion") continue;
    why = detail ? `${entry.msg}: ${detail}` : entry.msg;
  }
  return why;
}

/**
 * Waits for mongod to answer. If it exits instead, stops it (it would only
 * fail again every 5 s) and says why, from its log.
 */
async function waitForMongodb(ctx: Context, since: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    // ping needs no login.
    if ((await mongosh(ctx, "print(JSON.stringify(db.runCommand({ ping: 1 }).ok))", { as: "nobody", allowFail: true })).code === 0) return;
    const { stdout } = await ctx.exec(BIN.systemctl, ["show", "mongod", "--property=ActiveState,SubState,NRestarts"], { allowFail: true });
    if (/^(ActiveState=(failed|inactive)|SubState=auto-restart.*|NRestarts=[1-9]\d*)$/m.test(stdout)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const log = await ctx.exec(BIN.journalctl, ["--no-pager", "-o", "cat", "-n", "200", "-u", "mongod", `--since=@${Math.floor(since / 1000)}`], { allowFail: true });
  await ctx.exec(BIN.systemctl, ["disable", "--now", "mongod"], { allowFail: true });
  const why = mongodFailure(log.stdout);
  throw new ActionError("start_failed", why ? `MongoDB didn't start. From its log: ${why}` : "MongoDB didn't start, and its log doesn't say why (journalctl -u mongod)");
}

/**
 * The agent's own login (root on MongoDB), saved root 600. The first install
 * makes it through MongoDB's localhost exception: while there are no users at
 * all, a connection from 127.0.0.1 may create the first one.
 */
async function ensureMongoAdmin(ctx: Context): Promise<void> {
  const saved = readMongoAdmin(ctx);
  if (saved) {
    const r = await mongosh(ctx, "print(JSON.stringify(db.runCommand({ connectionStatus: 1 }).authInfo.authenticatedUsers.map((u) => u.user)))", { allowFail: true });
    const users = lastJson(r.stdout);
    if (r.code === 0 && Array.isArray(users) && users.includes(saved.user)) return;
    throw new ActionError("auth_failed", `MongoDB doesn't accept the agent's login in ${ctx.paths.mongodbAdmin}`);
  }
  const admin = { user: "layer", password: randomBytes(24).toString("hex") };
  // Saved before the user exists: losing it after would lock the agent out for good.
  mkdirSync(dirname(ctx.paths.mongodbAdmin), { recursive: true, mode: 0o700 });
  writeFileAtomic(ctx.paths.mongodbAdmin, JSON.stringify(admin) + "\n", 0o600);
  const r = await mongosh(ctx, `db.getSiblingDB("admin").createUser({ user: ${q(admin.user)}, pwd: ${q(admin.password)}, roles: ["root"] }); print(JSON.stringify(1))`, { as: "nobody", allowFail: true });
  if (r.code !== 0) {
    rmSync(ctx.paths.mongodbAdmin, { force: true });
    throw new ActionError("install_failed", `couldn't make the agent's MongoDB login (does the server have users already?): ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ")}`);
  }
}

async function installMongodb(ctx: Context) {
  const already = mongodbInstalled(ctx);
  if (!mongodbPackages()) {
    const os = osRelease();
    const source = mongodbSource(os.id, os.codename, process.arch);
    if ("error" in source) throw new ActionError("unsupported", source.error);
    ensureDir(dirname(MONGODB_KEYRING), 0o755);
    writeFileAtomic(MONGODB_KEYRING, MONGODB_SIGNING_KEY, 0o644);
    writeFileAtomic(MONGODB_SOURCES, source.line + "\n", 0o644);
    await apt(ctx, ["update", "-q"], "layer-apt-update");
    const r = await apt(ctx, ["install", "-y", "-q", "--no-install-recommends", "mongodb-org-server", "mongodb-mongosh", "mongodb-database-tools"], "layer-apt-install");
    if (r.code !== 0 || !mongodbPackages()) {
      // Without MongoDB, its repository has no business in apt's sources.
      rmSync(MONGODB_SOURCES, { force: true });
      throw new ActionError("install_failed", `couldn't install MongoDB with apt: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
    }
  }
  writeFileAtomic(MONGOSH_CONF, renderMongoshConf(), 0o644);
  writeFileAtomic(MONGOD_CONF, renderMongodConf(Math.round(totalmem() / 1048576)), 0o644);
  ensureDir(join(ctx.paths.systemdDir, "mongod.service.d"), 0o755);
  writeFileAtomic(join(ctx.paths.systemdDir, "mongod.service.d", "layer.conf"), renderMongodDropin(), 0o644);
  await ctx.exec(BIN.systemctl, ["daemon-reload"]);
  await ctx.exec(BIN.systemctl, ["enable", "mongod"], { allowFail: true });
  // Earlier failed starts don't count against the start limit, or as restarts.
  await ctx.exec(BIN.systemctl, ["reset-failed", "mongod"], { allowFail: true });
  const since = Date.now();
  await ctx.exec(BIN.systemctl, ["restart", "mongod"], { allowFail: true });
  await waitForMongodb(ctx, since);
  await ensureMongoAdmin(ctx);
  const version = lastJson((await mongosh(ctx, "print(JSON.stringify(db.version()))")).stdout);
  return { name: "mongodb", installed: true, version: typeof version === "string" ? version : null, already };
}

async function mongodbAdd(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const app = appLayout(ctx, slug);
  if (!existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  if (!mongodbInstalled(ctx)) throw new ActionError("not_installed", "MongoDB isn't installed yet (service.install mongodb)");
  const state = readServices(ctx, slug);
  const name = pgName(slug);
  const m = state.mongodb ?? { database: name, user: name, password: randomBytes(24).toString("hex") };
  // The user lives in the app's database and may read, write and manage that one only.
  await mongosh(
    ctx,
    [
      `const d = db.getSiblingDB(${q(m.database)});`,
      `const roles = [{ role: "readWrite", db: ${q(m.database)} }, { role: "dbAdmin", db: ${q(m.database)} }];`,
      `if (d.getUser(${q(m.user)})) d.updateUser(${q(m.user)}, { pwd: ${q(m.password)}, roles });`,
      `else d.createUser({ user: ${q(m.user)}, pwd: ${q(m.password)}, roles });`,
      "print(JSON.stringify(1));",
    ].join("\n"),
  );
  writeServices(ctx, slug, { ...state, mongodb: m });
  // Prove the URL the app gets works: log in with it, the way the app will.
  const r = await mongosh(ctx, "print(JSON.stringify(db.runCommand({ connectionStatus: 1 }).authInfo.authenticatedUsers.map((u) => u.user)))", { as: { url: serviceEnv({ mongodb: m }).MONGODB_URI! }, allowFail: true });
  const users = lastJson(r.stdout);
  if (r.code !== 0 || !Array.isArray(users) || !users.includes(m.user)) throw new ActionError("start_failed", `the new login doesn't work: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ")}`);
  return { slug, database: m.database, env: ["MONGODB_URI"] };
}

/** A config file holding the login for MongoDB's tools (mongodump, mongorestore): never in their arguments. */
async function withToolLogin<T>(url: string, run: (config: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "layer-mongotools-"));
  try {
    const config = join(dir, "login.yaml");
    writeFileSync(config, `uri: ${q(url)}\n`, { mode: 0o600 });
    return await run(config);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Drops the app's database and user. With keepData, a mongodump goes to the archive first. */
export async function removeMongodb(ctx: Context, slug: string, keepData = true): Promise<{ archived: string | null } | null> {
  const app = appLayout(ctx, slug);
  const state = existsSync(app.etcDir) ? readServices(ctx, slug) : {};
  const m = state.mongodb;
  if (!m || !mongodbInstalled(ctx)) return null;
  const admin = readMongoAdmin(ctx);
  if (!admin) throw new ActionError("not_installed", "MongoDB has no login for the agent yet (service.install mongodb)");
  const archived = keepData
    ? await withToolLogin(`mongodb://${admin.user}:${admin.password}@127.0.0.1:27017/?authSource=admin`, (config) =>
        archiveDump(ctx, slug, "mongodump.gz", BIN.mongodump, [`--config=${config}`, `--db=${m.database}`, "--archive", "--gzip", "--quiet"], m.database),
      )
    : null;
  await mongosh(ctx, `const d = db.getSiblingDB(${q(m.database)}); d.dropDatabase(); if (d.getUser(${q(m.user)})) d.dropUser(${q(m.user)}); print(JSON.stringify(1));`);
  if (existsSync(app.etcDir)) {
    const { mongodb: _removed, ...rest } = state;
    writeServices(ctx, slug, rest);
  }
  return { archived };
}

async function mongodbRemove(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const keepData = params.keepData ?? true;
  if (typeof keepData !== "boolean") throw new ValidationError("keepData", "must be true or false");
  const result = await removeMongodb(ctx, slug, keepData);
  if (!result) throw new ActionError("not_found", `${slug} has no MongoDB`);
  return { slug, removed: true, archived: result.archived };
}

export const serviceActions: ActionTable = {
  "service.install": { mutates: true, run: serviceInstall },
  "service.status": { mutates: false, run: serviceStatus },
  "redis.add": { mutates: true, run: redisAdd },
  "redis.remove": { mutates: true, run: redisRemove },
  "postgres.add": { mutates: true, run: postgresAdd },
  "postgres.remove": { mutates: true, run: postgresRemove },
  "mysql.add": { mutates: true, run: mysqlAdd },
  "mysql.remove": { mutates: true, run: mysqlRemove },
  "mongodb.add": { mutates: true, run: mongodbAdd },
  "mongodb.remove": { mutates: true, run: mongodbRemove },
};

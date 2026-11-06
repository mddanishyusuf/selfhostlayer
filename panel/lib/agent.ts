import { AgentError, callAgent, type ActionName, type CallOptions } from "@layer/protocol";
import { config } from "./config";
import { currentServer, getServer, serverOfSlug, sshTransport } from "./servers";

export interface SystemInfo {
  agentVersion: string;
  hostname: string;
  os: { id: string; version: string; name: string };
  kernel: string;
  arch: string;
  cpus: number;
  loadavg: number[];
  memoryMb: { total: number; available: number };
  swapMb: { total: number; free: number };
  diskGb: { total: number; free: number };
  uptimeSec: number;
  nodeVersions: string[];
  caddy: string;
}

export interface AppSummary {
  slug: string;
  ports: { blue: number | null; green: number | null };
  live: "blue" | "green" | "static" | null;
  domains: string[];
  unitFile: boolean;
}

/** How `systemctl show` prints a time. */
const systemdTime = (ms: number) => `Thu ${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;

const FAKE: Partial<Record<ActionName, unknown>> = {
  "system.info": {
    agentVersion: "dev",
    hostname: "cx23-fsn1",
    os: { id: "ubuntu", version: "24.04", name: "Ubuntu 24.04.5 LTS" },
    kernel: "6.8.0-147-generic",
    arch: "x64",
    cpus: 2,
    loadavg: [0.42, 0.31, 0.27],
    memoryMb: { total: 3820, available: 2240 },
    swapMb: { total: 2048, free: 2001 },
    diskGb: { total: 38.2, free: 24.6 },
    uptimeSec: 1_314_000,
    nodeVersions: ["22.23.4", "24.13.1"],
    caddy: "active",
  } satisfies SystemInfo,
  "app.list": {
    apps: [
      { slug: "piqo", ports: { blue: 4000, green: 4001 }, live: "green", domains: ["piqo.app", "www.piqo.app"], unitFile: true },
      { slug: "maillayer", ports: { blue: 4002, green: 4003 }, live: "blue", domains: ["maillayer.com"], unitFile: true },
      { slug: "picker", ports: { blue: 4004, green: 4005 }, live: null, domains: [], unitFile: false },
    ] satisfies AppSummary[],
  },
  // A newer release in the feed, and an update that never ends (dev has no installer to run).
  "update.check": { current: "dev", latest: { version: "0.2.0", date: "2026-11-02", notes: "An Update button in the sidebar when a newer release is out.\nAlbert Sans in the panel." }, available: true, running: false },
  "update.start": { from: "dev", to: "0.2.0", unit: "layer-update.service" },
  "update.status": {
    running: true,
    state: "active",
    result: null,
    exitStatus: null,
    version: "dev",
    log: ["==> Checking this server", "  ✓ Ubuntu 24.04 on x86_64", "==> Installing Self Host Layer", "  ✓ Release 0.2.0 in /opt/layer/current", "==> Restarting the agent and the panel"],
  },
  // Sample answers for the dev previews (the same for every app).
  "firewall.status": {
    ufw: {
      installed: true,
      enabled: true,
      rules: [
        ["tcp", "22", "ssh"],
        ["tcp", "80", "http"],
        ["tcp", "443", "https"],
        ["udp", "443", "http3"],
      ].flatMap(([protocol, port, comment]) => [false, true].map((ipv6) => ({ action: "allow", protocol, port, from: "Anywhere", ipv6, comment }))),
    },
    fail2ban: { running: true, jails: [{ name: "sshd", currentlyFailed: 2, totalFailed: 31, currentlyBanned: 2, totalBanned: 9, banned: ["185.220.101.47", "45.148.10.243"] }] },
  },
  "service.status": {
    slug: "piqo",
    installed: { redis: true, postgres: true, mysql: false, mongodb: true },
    running: { postgres: true, mysql: false, mongodb: true },
    redis: { port: 6400, memoryMb: 64, url: "redis://default:51b0e9c2aa7741f8@127.0.0.1:6400", active: true, memoryUsedMb: 23, answering: true },
    postgres: { database: "app_piqo", url: "postgresql://app_piqo:9f2c41d07be6a1e3@127.0.0.1:5432/app_piqo", sizeMb: 48.2, answering: true },
    mongodb: { database: "app_piqo", url: "mongodb://app_piqo:7c1e93a0d24b5f68@127.0.0.1:27017/app_piqo", sizeMb: 12.4, answering: true },
  },
  "unit.status": {
    slug: "piqo",
    live: "blue",
    unitFile: true,
    blue: { state: "active", subState: "running", enabled: true, pid: 4120, memoryMb: 212, restarts: 0, since: null, release: "a1c9e42", port: 4000, live: true },
    green: { state: "inactive", subState: "dead", enabled: false, pid: null, memoryMb: null, restarts: 0, since: null, release: null, port: 4001, live: false },
  },
  "security.score": { slug: "piqo", color: "blue", score: 1.3, rating: "OK" },
  "cron.list": {
    slug: "piqo",
    jobs: [
      {
        name: "aggregate-stats",
        calendar: "*-*-* *:00:00",
        nextRun: systemdTime(Date.now() + 42 * 60_000),
        lastRun: systemdTime(Date.now() - 18 * 60_000),
        running: false,
        lastResult: "success",
        lastExitStatus: 0,
      },
    ],
  },
  "worker.list": {
    slug: "piqo",
    workers: [
      { name: "queue", state: "active", subState: "running", result: "success", restarts: 0, memoryBytes: 61_865_984, since: systemdTime(Date.now() - 3 * 3600_000), exitStatus: 0 },
      { name: "mailer", state: "failed", subState: "failed", result: "exit-code", restarts: 5, memoryBytes: null, since: null, exitStatus: 1 },
    ],
  },
  "worker.write": { started: true },
  "worker.control": {},
  "worker.delete": { deleted: true },
  "app.run-stop": { stopped: true },
  "metrics.sample": {
    at: Date.now(),
    box: { cpu: { busy: 1000, total: 10000 }, cpus: 2, memoryMb: { used: 610, total: 3800 }, diskGb: { used: 8, total: 38 } },
    apps: { piqo: { cpuNs: 5_000_000_000, memoryMb: 212 } },
  },
  "metrics.disk": { apps: { piqo: 310 } },
  "proxy.set": {},
  "requests.tail": {
    slug: "piqo",
    requests: [
      { at: Date.now() - 4_000, status: 200, method: "GET", host: "piqo.app", uri: "/", ip: "203.0.113.24", ms: 38, bytes: 14_220 },
      { at: Date.now() - 9_000, status: 200, method: "POST", host: "piqo.app", uri: "/api/collect", ip: "198.51.100.7", ms: 6, bytes: 2 },
      { at: Date.now() - 31_000, status: 304, method: "GET", host: "piqo.app", uri: "/_next/static/chunks/main.js", ip: "203.0.113.24", ms: 1, bytes: 0 },
      { at: Date.now() - 64_000, status: 404, method: "GET", host: "piqo.app", uri: "/wp-login.php", ip: "45.148.10.243", ms: 3, bytes: 1_240 },
      { at: Date.now() - 98_000, status: 502, method: "GET", host: "piqo.app", uri: "/dashboard", ip: "203.0.113.24", ms: 5_004, bytes: 0 },
    ],
  },
  "audit.tail": {
    entries: [
      { id: "a3", ts: new Date(Date.now() - 120_000).toISOString(), action: "proxy.set", params: { slug: "piqo", color: "blue", domains: ["piqo.app"] }, ok: true, code: null, ms: 412 },
      { id: "a2", ts: new Date(Date.now() - 180_000).toISOString(), action: "unit.start", params: { slug: "piqo", color: "blue" }, ok: true, code: null, ms: 2210 },
      { id: "a1", ts: new Date(Date.now() - 260_000).toISOString(), action: "build.run", params: { slug: "piqo", sha: "a1c9e42" }, ok: true, code: null, ms: 61_000 },
      { id: "a0", ts: new Date(Date.now() - 3_600_000).toISOString(), action: "postgres.add", params: { slug: "maillayer" }, ok: false, code: "install_failed", message: "couldn't install postgresql with apt: E: Could not get lock /var/lib/dpkg/lock-frontend", ms: 48_000 },
    ],
  },
  "data.import": {
    slug: "piqo",
    previous: "data.before-restore-20261030090000-1a2b3c",
    sqlite: [{ path: "piqo.db", bytes: 210_000_000 }],
    files: 1204,
    bytes: 262_144_000,
    restarted: ["app-piqo@blue.service"],
  },
  "cron.history": {
    slug: "piqo",
    name: "aggregate-stats",
    runs: [
      { invocation: "b2", startedAt: new Date(Date.now() - 18 * 60_000).toISOString(), finishedAt: new Date(Date.now() - 18 * 60_000 + 2400).toISOString(), status: "success", exitStatus: 0, output: ["Aggregating 41,203 events…", "Wrote 1,204 daily rows in 2.3s"] },
      { invocation: "b1", startedAt: new Date(Date.now() - 78 * 60_000).toISOString(), finishedAt: new Date(Date.now() - 78 * 60_000 + 900).toISOString(), status: "failed", exitStatus: 1, output: ["Error: SQLITE_BUSY: database is locked"] },
    ],
  },
};

/** The viewer's sample databases, shaped like each engine's answers. */
/** Sample databases per app for the dev previews: piqo and picker keep SQLite, the others use the shared servers. */
const FAKE_SQLITE: Record<string, { path: string; bytes: number; tables: number | null }[]> = {
  piqo: [{ path: "piqo.db", bytes: 222_300_000, tables: 14 }, { path: "cache/sessions.db", bytes: 81_920, tables: 1 }],
  picker: [{ path: "picker.db", bytes: 18_870_000, tables: 6 }],
  blogcms: [{ path: "blog.db", bytes: 9_430_000, tables: 7 }],
};

function fakeServiceStatus(p: Record<string, unknown>) {
  const base = FAKE["service.status"] as Record<string, unknown>;
  const engines = { installed: base.installed, running: base.running };
  if (p.slug === undefined) return { ...engines, versions: { postgres: "17", redis: "8.0", mongodb: "9.0" } };
  const url = (scheme: string, db: string, port: number) => `${scheme}://${db}:9f2c41d07be6a1e3@127.0.0.1:${port}/${db}`;
  const sql = (db: string, sizeMb: number, tables: number) => ({ database: db, url: url("postgresql", db, 5432), sizeMb, tables, answering: true });
  const redis = (port: number, memoryUsedMb: number, keys: number) => ({ port, memoryMb: 64, url: `redis://default:51b0e9c2aa7741f8@127.0.0.1:${port}`, active: true, memoryUsedMb, keys, answering: true });
  const apps: Record<string, Record<string, unknown>> = {
    piqo: { redis: redis(6400, 18, 2_410) },
    maillayer: { postgres: sql("app_maillayer", 39.4, 22) },
    postscheduler: { postgres: sql("app_postscheduler", 6.1, 9), redis: redis(6401, 32, 880) },
    blogcms: { mongodb: { database: "app_blogcms", url: url("mongodb", "app_blogcms", 27017), sizeMb: 4.2, collections: 3, answering: true } },
  };
  return { slug: p.slug, ...engines, ...(apps[String(p.slug)] ?? {}) };
}

/** A command's output, a line at a time, like app.run streams it. */
async function fakeRun(onChunk?: (chunk: string) => void) {
  const lines = ["$ node migrations/mongo-to-sqlite.js", "Connecting to MongoDB…", "Copied 1,204 documents from users", "Copied 88 documents from teams", "\x1b[32mDone\x1b[0m in 2.1s"];
  for (const line of lines) {
    await new Promise((r) => setTimeout(r, 400));
    onChunk?.(`${line}\n`);
  }
  return { code: 0, ms: 2100, timedOut: false };
}

function fakeBrowse(p: Record<string, unknown>) {
  if (p.engine === "sqlite" && !p.file) return { files: FAKE_SQLITE[String(p.slug)] ?? [], tables: [] };
  const settings = JSON.stringify({ theme: "dark", publicDashboard: true, excludePaths: ["/admin", "/preview"], goals: [{ name: "Signup", path: "/thanks" }] });
  const byEngine: Record<string, { tables: { name: string; type: string; rows: number | null }[]; columns: string[]; rows: unknown[][]; total: number }> = {
    mongodb: {
      tables: [{ name: "posts", type: "collection", rows: 214 }, { name: "comments", type: "collection", rows: 1_840 }, { name: "drafts", type: "view", rows: null }],
      columns: ["_id", "title", "tags", "published", "author"],
      rows: [
        ['ObjectId("65f0c0ffee0000000000ab01")', "Self-hosting on a $5 box", '["hosting","indie"]', true, '{"name":"Danish","handle":"mddanishyusuf"}'],
        ['ObjectId("65f0c0ffee0000000000ab02")', "Why no Docker", '["docker"]', false, { missing: true }],
      ],
      total: 214,
    },
    redis: {
      tables: [{ name: "queue:emails", type: "list", rows: 3 }, { name: "session:8f2a41c0", type: "string", rows: 128 }, { name: "stats:today", type: "hash", rows: 4 }],
      columns: ["field", "value"],
      rows: [["visits", "1843"], ["signups", "12"], ["bounce", "0.41"], ["top", "/pricing"]],
      total: 4,
    },
  };
  const sql = {
    tables: [{ name: "daily_stats", type: "view", rows: null }, { name: "events", type: "table", rows: 48_210 }, { name: "sites", type: "table", rows: 12 }, { name: "users", type: "table", rows: 3 }],
    columns: ["id", "domain", "owner_id", "created_at", "settings", "logo"],
    rows: [
      [1, "piqo.app", 1, "2026-03-02 09:14:00", settings, { bytes: 18_204 }],
      [2, "maillayer.com", 1, "2026-04-11 17:02:41", { text: settings.repeat(40).slice(0, 2000), length: 9_800 }, null],
      [3, "blog.mohddanish.com", 2, "2026-05-30 08:00:12", null, null],
    ],
    total: 12,
  };
  const d = byEngine[String(p.engine)] ?? sql;
  if (p.op === "tables") return { tables: d.tables };
  if (p.op === "query" && p.engine !== "mongodb" && p.engine !== "redis") return { tables: d.tables, result: { columns: ["domain", "visits"], rows: [["piqo.app", 48_210], ["maillayer.com", 9_120]], total: null, truncated: false, ms: 3 } };
  if (d === sql) {
    // A SQL table: what editing needs (columns' types, each row's key); a view can't be edited.
    const editable = sql.tables.find((t) => t.name === p.table)?.type === "table";
    const types = ["integer", "text", "integer", "timestamp", "jsonb", "bytea"];
    const where = p.where as { filters?: unknown[] } | undefined;
    const rows = where?.filters?.length ? d.rows.slice(0, 1) : d.rows;
    return {
      tables: d.tables,
      result: {
        columns: d.columns,
        rows,
        total: where?.filters?.length ? 1 : d.total,
        truncated: false,
        ms: 4,
        schema: d.columns.map((c, i) => ({ name: c, type: types[i] ?? "text", nullable: c !== "id" && c !== "domain", pk: c === "id" })),
        editable,
        key: editable ? { columns: ["id"], rows: rows.map((r) => [r[0] as number]) } : null,
      },
    };
  }
  return { tables: d.tables, result: { columns: d.columns, rows: d.rows, total: d.total, truncated: false, ms: 4, ...(p.engine === "redis" ? { ttl: -1 } : {}) } };
}

/** Editing in fake mode: the count is the rows picked by key, 12 for filters or the whole table. */
function fakeEdit(action: "db.count" | "db.update", p: Record<string, unknown>) {
  const target = (p.target ?? {}) as { keys?: { rows: unknown[] } };
  const matches = target.keys ? target.keys.rows.length : 12;
  return action === "db.count" ? { matches } : { updated: Number(p.expect ?? matches) };
}

/**
 * Calls an agent: the panel's own, or another server's over SSH
 * (lib/servers.ts). Which one: the server asked for (opts.server), else the
 * server of the app the call is about (its slug), else the server the work in
 * progress is for (a deploy, onServer), else the panel's own.
 */
export async function agent<T>(action: ActionName, params: Record<string, unknown> = {}, opts: Omit<CallOptions, "socket" | "transport"> & { server?: number | null } = {}): Promise<T> {
  const { server: asked, ...callOpts } = opts;
  // A known slug decides (null: the panel's own server); an unknown one (a new app) follows the work in progress.
  const ofSlug = typeof params.slug === "string" ? serverOfSlug(params.slug) : undefined;
  const serverId = asked !== undefined ? asked : ofSlug !== undefined ? ofSlug : (currentServer() ?? null);
  if (serverId !== null) {
    const server = getServer(serverId);
    if (!server) throw new AgentError("not_found", "that server isn't in the panel any more");
    return callAgent<T>(action, params, { ...callOpts, transport: sshTransport(server) });
  }
  if (config.fakeAgent && action === "db.browse") return fakeBrowse(params) as T;
  if (config.fakeAgent && (action === "db.count" || action === "db.update")) return fakeEdit(action, params) as T;
  if (config.fakeAgent && action === "service.status") return fakeServiceStatus(params) as T;
  if (config.fakeAgent && action === "app.run") return fakeRun(callOpts.onChunk) as T;
  if (config.fakeAgent && action in FAKE) return FAKE[action] as T;
  return callAgent<T>(action, params, { ...callOpts, socket: config.agentSocket });
}

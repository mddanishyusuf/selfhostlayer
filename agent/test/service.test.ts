import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appActions } from "../src/actions/app.ts";
import { grantPattern, mongodFailure, renderMariadbConf, serviceActions, serviceEnv } from "../src/actions/service.ts";
import { NO_IO } from "../src/context.ts";
import { mongodbSource, renderMongodConf, renderMongodDropin, renderMongoshConf } from "../src/templates/mongodb.ts";
import { renderRedisConf, renderRedisUnit } from "../src/templates/redis.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

const input = { slug: "piqo", port: 6400, password: "ab".repeat(24), memoryMb: 64, binary: "/usr/bin/redis-server" };

describe("Redis templates", () => {
  it("binds to 127.0.0.1 with a password, a memory cap and data in the app's folder", async () => {
    const conf = renderRedisConf(input);
    await expect(conf).toMatchFileSnapshot("./__snapshots__/piqo-redis.conf");
    expect(conf).toContain("bind 127.0.0.1\n");
    expect(conf).toContain(`requirepass ${"ab".repeat(24)}\n`);
    expect(conf).toContain("dir /srv/apps/piqo/data/redis\n");
    expect(conf).toContain("maxmemory-policy noeviction\n");
  });

  it("runs as the app's user in the same sandbox, writing only data/redis", async () => {
    const unit = renderRedisUnit(input);
    await expect(unit).toMatchFileSnapshot("./__snapshots__/layer-redis-piqo.service");
    expect(unit).toContain("User=app-piqo\n");
    expect(unit).toContain("ReadWritePaths=/srv/apps/piqo/data/redis\n");
    expect(unit).toContain("MemoryMax=128M\n");
    expect(() => renderRedisUnit({ ...input, binary: "/tmp/redis-server" })).toThrow();
    expect(() => renderRedisConf({ ...input, password: "a b\nport 1" })).toThrow();
  });

  it("hands apps a REDIS_URL and DATABASE_URL", () => {
    expect(serviceEnv({ redis: { port: 6400, password: "pw", memoryMb: 64 }, postgres: { database: "app_piqo", user: "app_piqo", password: "x" } })).toEqual({
      REDIS_URL: "redis://default:pw@127.0.0.1:6400",
      DATABASE_URL: "postgresql://app_piqo:x@127.0.0.1:5432/app_piqo",
    });
  });
});

describe("MySQL (MariaDB)", () => {
  it("hands apps a mysql:// DATABASE_URL", () => {
    expect(serviceEnv({ mysql: { database: "app_piqo", user: "app_piqo", password: "x" } })).toEqual({ DATABASE_URL: "mysql://app_piqo:x@127.0.0.1:3306/app_piqo" });
  });

  it("is tuned for a small box and listens on 127.0.0.1 only", () => {
    expect(renderMariadbConf(1024)).toContain("innodb_buffer_pool_size = 64M\n");
    expect(renderMariadbConf(256)).toContain("innodb_buffer_pool_size = 32M\n");
    expect(renderMariadbConf(65536)).toContain("innodb_buffer_pool_size = 512M\n");
    expect(renderMariadbConf(2048)).toContain("bind-address = 127.0.0.1\n");
  });

  it("escapes _ in grants, where it would match any character", () => {
    expect(grantPattern("app_my_app")).toBe("app\\_my\\_app");
  });
});

describe("MongoDB", () => {
  const login = { database: "app_piqo", user: "app_piqo", password: "x" };

  it("hands apps MONGODB_URI, next to a SQL DATABASE_URL", () => {
    expect(serviceEnv({ mongodb: login, postgres: login })).toEqual({
      DATABASE_URL: "postgresql://app_piqo:x@127.0.0.1:5432/app_piqo",
      MONGODB_URI: "mongodb://app_piqo:x@127.0.0.1:27017/app_piqo",
    });
  });

  it("is tuned for a small box: 127.0.0.1 only, logins required, a small cache", async () => {
    const conf = renderMongodConf(2048);
    await expect(conf).toMatchFileSnapshot("./__snapshots__/mongodb-layer.conf");
    expect(conf).toContain("  bindIp: 127.0.0.1\n");
    expect(conf).toContain("  authorization: enabled\n");
    expect(conf).toContain("cacheSizeGB: 0.25\n");
    expect(renderMongodConf(8192)).toContain("cacheSizeGB: 0.5\n");
    expect(renderMongodConf(65536)).toContain("cacheSizeGB: 1\n");
    // The package's own config stays untouched; the drop-in points mongod at ours.
    const dropin = renderMongodDropin();
    expect(dropin).toContain("ExecStart=\nExecStart=/usr/bin/mongod --config /etc/mongodb-layer.conf\n");
    // Per-thread allocator caches, or MongoDB refuses kernels 6.19.0 to 7.0.13 (all of Ubuntu 26.04's).
    expect(dropin).toContain("Environment=GLIBC_TUNABLES=glibc.pthread.rseq=1\n");
    expect(dropin).toContain("StartLimitBurst=5\n");
    expect(renderMongoshConf()).toContain("enableTelemetry: false\n");
  });

  it("finds why mongod stopped in its log", () => {
    const systemd = "mongod.service: Main process exited, code=exited, status=1/FAILURE";
    // From Ubuntu 26.04 (kernel 7.0.0-30), with the package's own allocator setting.
    const kernel = `{"t":{"$date":"2026-10-30T13:08:06.052+00:00"},"s":"F",  "c":"CONTROL",  "id":12257600,"ctx":"main","msg":"MongoDB cannot start: Linux kernel versions 6.19.0 through 7.0.13 have a known incompatibility with this version of MongoDB. See https://jira.mongodb.org/browse/SERVER-121912 for more information."}`;
    expect(mongodFailure([kernel, systemd].join("\n"))).toMatch(/^MongoDB cannot start: Linux kernel versions 6\.19\.0 through 7\.0\.13 /);

    // A restart with the data folder unreadable: the old mongod aborts on its way out, the new one can't start.
    const wiredTiger = `{"t":{"$date":"2026-10-30T13:23:09.157+00:00"},"s":"E",  "c":"WT",       "id":22435,   "ctx":"SignalHandler","msg":"WiredTiger error message","attr":{"error":13,"message":{"session_name":"close_ckpt","msg":"int __posix_fs_size(WT_FILE_SYSTEM *, WT_SESSION *, const char *, wt_off_t *):403:/var/lib/mongodb/_tmp/spilldb/WiredTigerHS.wt: file-size: stat","error_str":"Permission denied","error_code":13}}}`;
    const assertion = `{"t":{"$date":"2026-10-30T13:23:09.158+00:00"},"s":"F",  "c":"ASSERT",   "id":23089,   "ctx":"SignalHandler","msg":"Fatal assertion","attr":{"msgid":28559,"location":"src/mongo/db/storage/wiredtiger/wiredtiger_error_util.cpp:149:69"}}`;
    const aborting = `{"t":{"$date":"2026-10-30T13:23:09.158+00:00"},"s":"F",  "c":"ASSERT",   "id":23090,   "ctx":"SignalHandler","msg":"\\n\\n***aborting after fassert() failure\\n\\n"}`;
    const fatal = `{"t":{"$date":"2026-10-30T13:23:09.158+00:00"},"s":"F",  "c":"CONTROL",  "id":6384300, "ctx":"SignalHandler","msg":"Writing fatal message","attr":{"message":"Got signal: 6 (Aborted).\\n"}}`;
    const denied = `{"t":{"$date":"2026-10-30T13:23:12.182+00:00"},"s":"E",  "c":"CONTROL",  "id":20557,   "ctx":"initandlisten","msg":"DBException in initAndListen, terminating","attr":{"error":"Location28596: Unable to determine status of lock file in the data directory /var/lib/mongodb: boost::filesystem::status: Permission denied"}}`;
    expect(mongodFailure([wiredTiger, assertion, aborting, fatal, fatal, systemd, denied, systemd].join("\n"))).toBe(
      "DBException in initAndListen, terminating: Location28596: Unable to determine status of lock file in the data directory /var/lib/mongodb: boost::filesystem::status: Permission denied",
    );
    expect(mongodFailure([wiredTiger, assertion, aborting, fatal].join("\n"))).toBe("WiredTiger error message: Permission denied");
    expect(mongodFailure([assertion, aborting, fatal, systemd, "{not json"].join("\n"))).toBeNull();
  });

  it("picks MongoDB's apt source for the OS, and says why when there's none", () => {
    expect(mongodbSource("ubuntu", "resolute", "arm64")).toEqual({
      line: "deb [ arch=arm64 signed-by=/etc/apt/keyrings/mongodb-server-9.asc ] https://repo.mongodb.org/apt/ubuntu resolute/mongodb-org/9.0 multiverse",
    });
    expect(mongodbSource("ubuntu", "noble", "x64")).toMatchObject({ line: expect.stringContaining("arch=amd64") });
    expect(mongodbSource("debian", "bookworm", "x64")).toMatchObject({ line: expect.stringContaining("debian bookworm/mongodb-org/9.0 main") });
    expect(mongodbSource("debian", "bookworm", "arm64")).toMatchObject({ error: expect.stringContaining("no ARM packages for Debian") });
    expect(mongodbSource("ubuntu", "jammy", "x64")).toMatchObject({ error: expect.stringContaining("no packages for ubuntu jammy") });
  });
});

describe("one SQL database per app", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = testEnv();
    await appActions["app.create"]!.run({ slug: "piqo" }, env.ctx, NO_IO);
  });
  afterEach(() => env.cleanup());
  const has = (state: object) => writeFileSync(join(env.paths.appEtcRoot, "piqo", "services.json"), JSON.stringify(state));
  const login = { database: "app_piqo", user: "app_piqo", password: "x" };

  it("refuses MySQL next to Postgres, and Postgres next to MySQL: both use DATABASE_URL", async () => {
    has({ postgres: login });
    await expect(serviceActions["mysql.add"]!.run({ slug: "piqo" }, env.ctx, NO_IO)).rejects.toThrow(/already has Postgres/);
    has({ mysql: login });
    await expect(serviceActions["postgres.add"]!.run({ slug: "piqo" }, env.ctx, NO_IO)).rejects.toThrow(/already has MySQL/);
  });
});

describe("redis.add", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = testEnv();
    await appActions["app.create"]!.run({ slug: "piqo" }, env.ctx, NO_IO);
  });
  afterEach(() => env.cleanup());

  it("refuses until Redis is installed", async () => {
    // Test machines have no /usr/bin/redis-server (and if they do, skip).
    if (existsSync("/usr/bin/redis-server") || existsSync("/usr/bin/valkey-server")) return;
    await expect(serviceActions["redis.add"]!.run({ slug: "piqo" }, env.ctx, NO_IO)).rejects.toThrow(/isn't installed/);
    expect(existsSync(join(env.paths.appEtcRoot, "piqo", "services.env"))).toBe(false);
  });

  it("refuses MongoDB until it's installed", async () => {
    // Test machines have no /usr/bin/mongod (and if they do, skip).
    if (existsSync("/usr/bin/mongod")) return;
    await expect(serviceActions["mongodb.add"]!.run({ slug: "piqo" }, env.ctx, NO_IO)).rejects.toThrow(/MongoDB isn't installed/);
    await expect(serviceActions["mongodb.add"]!.run({ slug: "nope" }, env.ctx, NO_IO)).rejects.toThrow(/doesn't exist/);
    await expect(serviceActions["mongodb.remove"]!.run({ slug: "piqo" }, env.ctx, NO_IO)).rejects.toThrow(/has no MongoDB/);
  });

  it("reports no services for a fresh app", async () => {
    const status = (await serviceActions["service.status"]!.run({ slug: "piqo" }, env.ctx, NO_IO)) as Record<string, unknown>;
    expect(status.redis).toBeUndefined();
    expect(readFileSync(join(env.paths.appEtcRoot, "piqo", "app.env"), "utf8")).not.toContain("REDIS_URL");
  });
});

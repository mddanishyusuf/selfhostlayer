import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appActions } from "../src/actions/app.ts";
import { serviceActions, serviceEnv } from "../src/actions/service.ts";
import { NO_IO } from "../src/context.ts";
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

  it("reports no services for a fresh app", async () => {
    const status = (await serviceActions["service.status"]!.run({ slug: "piqo" }, env.ctx, NO_IO)) as Record<string, unknown>;
    expect(status.redis).toBeUndefined();
    expect(readFileSync(join(env.paths.appEtcRoot, "piqo", "app.env"), "utf8")).not.toContain("REDIS_URL");
  });
});

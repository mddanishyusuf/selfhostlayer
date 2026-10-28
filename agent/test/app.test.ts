import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appActions } from "../src/actions/app.ts";
import { envActions } from "../src/actions/env.ts";
import { NO_IO } from "../src/context.ts";
import { BIN } from "../src/exec.ts";
import { allocatePortPair } from "../src/ports.ts";
import { renderColorEnv } from "../src/templates/env-file.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
beforeEach(() => (env = testEnv()));
afterEach(() => env.cleanup());

const create = (slug: string) => appActions["app.create"]!.run({ slug }, env.ctx, NO_IO) as Promise<any>;
const del = (params: Record<string, unknown>) => appActions["app.delete"]!.run(params, env.ctx, NO_IO) as Promise<any>;
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

describe("app.create", () => {
  it("creates the user with an exact, shell-free argv", async () => {
    await create("piqo");
    expect(env.fake.calls).toContainEqual([
      BIN.useradd,
      "--system",
      "--user-group",
      "--shell", "/usr/sbin/nologin",
      "--home-dir", join(env.paths.appsRoot, "piqo"),
      "--no-create-home",
      "--groups", "layer-apps",
      "app-piqo",
    ]);
  });

  it("lays out folders and env files with the documented modes", async () => {
    const res = await create("piqo");
    const app = join(env.paths.appsRoot, "piqo");
    const etc = join(env.paths.appEtcRoot, "piqo");
    expect(mode(app)).toBe("750");
    expect(mode(join(app, "releases"))).toBe("750");
    expect(mode(join(app, "data"))).toBe("700");
    expect(mode(join(etc, "app.env"))).toBe("600");
    expect(mode(join(etc, "blue.env"))).toBe("644");
    expect(res).toMatchObject({ slug: "piqo", user: "app-piqo", created: true });
    expect(readFileSync(join(etc, "blue.env"), "utf8")).toContain(`PORT=${res.ports.blue}`);
    expect(readFileSync(join(etc, "green.env"), "utf8")).toContain(`PORT=${res.ports.green}`);
  });

  it("is idempotent and keeps the same ports", async () => {
    const first = await create("piqo");
    writeFileSync(join(env.paths.appEtcRoot, "piqo", "app.env"), 'KEEP="me"\n');
    const second = await create("piqo");
    expect(second).toMatchObject({ created: false, ports: first.ports });
    expect(env.fake.calls.filter(([f]) => f === BIN.useradd)).toHaveLength(1);
    expect(readFileSync(join(env.paths.appEtcRoot, "piqo", "app.env"), "utf8")).toBe('KEEP="me"\n');
  });

  it("gives each app distinct ports", async () => {
    const a = await create("one");
    const b = await create("two");
    const all = [a.ports.blue, a.ports.green, b.ports.blue, b.ports.green];
    expect(new Set(all).size).toBe(4);
  });

  it("rejects bad slugs before touching anything", async () => {
    await expect(create("../root")).rejects.toThrow(/slug/);
    expect(env.fake.calls).toEqual([]);
  });
});

describe("app.delete", () => {
  it("removes everything and archives data by default", async () => {
    await create("piqo");
    writeFileSync(join(env.paths.appsRoot, "piqo", "data", "db.sqlite"), "rows");
    mkdirSync(env.paths.systemdDir, { recursive: true });
    writeFileSync(join(env.paths.systemdDir, "app-piqo@.service"), "[Unit]\n");

    const res = await del({ slug: "piqo" });
    expect(res.deleted).toBe(true);
    expect(readFileSync(join(res.archivedData, "db.sqlite"), "utf8")).toBe("rows");
    expect(existsSync(join(env.paths.appsRoot, "piqo"))).toBe(false);
    expect(existsSync(join(env.paths.appEtcRoot, "piqo"))).toBe(false);
    expect(existsSync(join(env.paths.systemdDir, "app-piqo@.service"))).toBe(false);
    expect(env.fake.users.has("app-piqo")).toBe(false);
    expect(env.fake.calls).toContainEqual([BIN.systemctl, "stop", "app-piqo@blue.service"]);
    expect(env.fake.calls).toContainEqual([BIN.systemctl, "daemon-reload"]);
  });

  it("deletes data when keepData is false", async () => {
    await create("piqo");
    expect((await del({ slug: "piqo", keepData: false })).archivedData).toBeNull();
  });

  it("validates input and reports unknown apps", async () => {
    await expect(del({ slug: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(del({ slug: "piqo", keepData: "yes" })).rejects.toThrow(/keepData/);
  });
});

describe("env.write", () => {
  it("writes app.env atomically with mode 600 and returns only keys", async () => {
    await create("piqo");
    const res = await envActions["env.write"]!.run({ slug: "piqo", vars: { A: "1", B: 'x"y' } }, env.ctx, NO_IO);
    expect(res).toEqual({ slug: "piqo", keys: ["A", "B"] });
    const file = join(env.paths.appEtcRoot, "piqo", "app.env");
    expect(mode(file)).toBe("600");
    expect(readFileSync(file, "utf8")).toContain('B="x\\"y"');
  });

  it("refuses unknown apps", async () => {
    await expect(envActions["env.write"]!.run({ slug: "ghost", vars: {} }, env.ctx, NO_IO)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("allocatePortPair", () => {
  it("skips ports owned by apps and ports something else listens on", async () => {
    const etc = env.paths.appEtcRoot;
    mkdirSync(join(etc, "old"), { recursive: true });
    writeFileSync(join(etc, "old", "blue.env"), renderColorEnv(5000));
    writeFileSync(join(etc, "old", "green.env"), renderColorEnv(5001));
    const busy = new Set([5002]);
    const pair = await allocatePortPair(etc, { min: 5000, max: 5010 }, async (p) => !busy.has(p));
    expect(pair).toEqual([5003, 5004]);
  });

  it("fails clearly when the range is exhausted", async () => {
    await expect(allocatePortPair(env.paths.appEtcRoot, { min: 5000, max: 5000 }, async () => true)).rejects.toMatchObject({
      code: "no_ports",
    });
  });
});

describe("ensureDir and symlinks", () => {
  it("refuses to chown or chmod through a symlink an app planted", async () => {
    const { ensureDir } = await import("../src/fsutil.ts");
    const { symlinkSync, mkdirSync: mk, statSync: st } = await import("node:fs");
    const target = join(env.root, "outside");
    mk(target, { mode: 0o755 });
    const link = join(env.root, "releases-link");
    symlinkSync(target, link);
    expect(() => ensureDir(link, 0o700)).toThrow(/not a real directory/);
    expect((st(target).mode & 0o777).toString(8)).toBe("755");
  });
});

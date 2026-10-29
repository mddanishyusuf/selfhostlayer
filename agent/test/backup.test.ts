import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appActions } from "../src/actions/app.ts";
import { backupActions } from "../src/actions/backup.ts";
import { NO_IO } from "../src/context.ts";
import { BIN } from "../src/exec.ts";
import { IMPORT_JOB, RESTORE_JOB, SNAPSHOT_JOB } from "../src/jobs.ts";
import { SYSTEMD_RUN } from "../src/sandbox.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
beforeEach(async () => {
  env = testEnv();
  await appActions["app.create"]!.run({ slug: "piqo" }, env.ctx, NO_IO);
});
afterEach(() => env.cleanup());

const snapshot = () => backupActions["backup.snapshot"]!.run({ slug: "piqo" }, env.ctx, NO_IO) as Promise<any>;
const restore = (file: string) => backupActions["backup.restore"]!.run({ slug: "piqo", file }, env.ctx, NO_IO) as Promise<any>;

describe("backup.snapshot", () => {
  it("runs the snapshot job as the app, offline, and stages its stdout for the panel", async () => {
    env.spawner.respond = () => ({ code: 0, stdout: "ARCHIVE", output: 'LAYER-SNAPSHOT {"sqlite":[{"path":"app.db","bytes":4096}]}\n' });
    const result = await snapshot();
    expect(result.file).toMatch(/^piqo-\d{14}-[0-9a-f]{8}\.tar\.gz$/);
    expect(result.sqlite).toEqual([{ path: "app.db", bytes: 4096 }]);
    expect(readFileSync(join(env.paths.stagingDir, result.file), "utf8")).toBe("ARCHIVE");
    const run = env.spawner.calls.find(([f]) => f === SYSTEMD_RUN)!;
    expect(run).toContain("--uid=app-piqo");
    expect(run).toContain("--property=IPAddressDeny=any");
    expect(run).toContain(`--property=ReadWritePaths=${join(env.paths.appsRoot, "piqo", "data")}`);
    expect(run.slice(run.indexOf("--") + 1)).toEqual([env.paths.runtimeNode, "--no-warnings", "-e", SNAPSHOT_JOB, join(env.paths.appsRoot, "piqo", "data")]);
  });

  it("deletes the partial file and reports the job's reason on failure", async () => {
    env.spawner.respond = () => ({ code: 3, stdout: "half", output: "layer: app.db failed SQLite's integrity check: page 3\n" });
    await expect(snapshot()).rejects.toThrow("app.db failed SQLite's integrity check");
    expect(readdirSync(env.paths.stagingDir)).toEqual([]);
  });

  it("clears staged snapshots older than a day", async () => {
    mkdirSync(env.paths.stagingDir, { recursive: true });
    const old = join(env.paths.stagingDir, "piqo-20261001000000-deadbeef.tar.gz");
    writeFileSync(old, "x");
    utimesSync(old, new Date("2026-10-01"), new Date("2026-10-01"));
    await snapshot();
    expect(readdirSync(env.paths.stagingDir)).not.toContain("piqo-20261001000000-deadbeef.tar.gz");
  });
});

describe("backup.restore", () => {
  const file = "piqo-20261029030000-1a2b3c4d.tar.gz";
  beforeEach(() => {
    mkdirSync(env.paths.restoreDir, { recursive: true });
    writeFileSync(join(env.paths.restoreDir, file), "ARCHIVE");
  });

  it("stops the running app, unpacks as the app user, and starts it again", async () => {
    env.fake.respond = (f, args) => (f === BIN.systemctl && args[0] === "is-active" ? { code: args[1]!.includes("@blue") ? 0 : 3, stdout: args[1]!.includes("@blue") ? "active\n" : "inactive\n", stderr: "" } : undefined);
    const result = await restore(file);
    expect(result.restarted).toEqual(["app-piqo@blue.service"]);
    const systemctl = env.fake.calls.filter(([f, a]) => f === BIN.systemctl && (a === "stop" || a === "start")).map((c) => c.slice(1).join(" "));
    expect(systemctl).toEqual(["stop app-piqo@blue.service", "start app-piqo@blue.service"]);
    const run = env.spawner.calls.find(([f]) => f === SYSTEMD_RUN)!;
    expect(run).toContain("--uid=app-piqo");
    expect(run.slice(run.indexOf("--") + 1, run.indexOf("--") + 5)).toEqual(["/bin/sh", "-c", RESTORE_JOB, "layer-restore"]);
  });

  it("starts the app again even when the restore fails", async () => {
    env.fake.respond = (f, args) => (f === BIN.systemctl && args[0] === "is-active" ? { code: 0, stdout: "active\n", stderr: "" } : undefined);
    env.spawner.respond = () => ({ code: 1 });
    await expect(restore(file)).rejects.toThrow("data/ is unchanged");
    expect(env.fake.calls.filter(([f, a]) => f === BIN.systemctl && a === "start")).toHaveLength(3);
  });

  it("restarts the app's Redis around it, so Redis loads the restored data/redis", async () => {
    const running = ["app-piqo@blue.service", "layer-redis-piqo.service"];
    env.fake.respond = (f, args) => (f === BIN.systemctl && args[0] === "is-active" ? (running.includes(args[1]!) ? { code: 0, stdout: "active\n", stderr: "" } : { code: 3, stdout: "inactive\n", stderr: "" }) : undefined);
    await restore(file);
    const order = env.fake.calls.filter(([f, a]) => f === BIN.systemctl && (a === "stop" || a === "start")).map((c) => c.slice(1).join(" "));
    expect(order).toEqual(["stop app-piqo@blue.service", "stop layer-redis-piqo.service", "start layer-redis-piqo.service", "start app-piqo@blue.service"]);
  });

  it("only takes plain file names from the restore folder", async () => {
    await expect(restore("../../etc/shadow")).rejects.toThrow(/backup file name/);
    await expect(restore("piqo-20261029030000-ffffffff.tar.gz")).rejects.toThrow(/isn't in/);
  });
});

describe("data.import", () => {
  const file = "piqo-20261030090000-0a1b2c3d.tar.gz";
  const appDir = () => join(env.paths.appsRoot, "piqo");
  const dataImport = () => backupActions["data.import"]!.run({ slug: "piqo", file }, env.ctx, NO_IO) as Promise<any>;
  const GZIP = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
  /** The job as the fake runs it: unpacks into data.importing-<stamp>/<root>, then reports. */
  const job = (root: string, report = `{"root":"${root}","sqlite":[{"path":"app.db","bytes":4096}],"files":1,"bytes":4096}`) => (f: string, args: string[]) => {
    if (f !== SYSTEMD_RUN) return undefined;
    const [, , , , dir, when] = args.slice(args.indexOf("--") + 1);
    const target = join(dir!, `data.importing-${when}`, root);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "app.db"), "IMPORTED");
    return { code: 0, output: `Checked app.db: ok\nLAYER-IMPORT ${report}\n` };
  };
  beforeEach(() => {
    mkdirSync(env.paths.restoreDir, { recursive: true });
    writeFileSync(join(env.paths.restoreDir, file), GZIP);
    mkdirSync(join(appDir(), "data"), { recursive: true });
    writeFileSync(join(appDir(), "data", "old.db"), "OLD");
  });

  it("unpacks and checks as the app, offline, then swaps with the app stopped", async () => {
    env.fake.respond = (f, args) => (f === BIN.systemctl && args[0] === "is-active" ? { code: args[1]!.includes("@blue") ? 0 : 3, stdout: args[1]!.includes("@blue") ? "active\n" : "inactive\n", stderr: "" } : undefined);
    env.spawner.respond = job("data");
    const result = await dataImport();
    expect(result).toMatchObject({ slug: "piqo", sqlite: [{ path: "app.db", bytes: 4096 }], files: 1, restarted: ["app-piqo@blue.service"] });
    expect(readFileSync(join(appDir(), "data", "app.db"), "utf8")).toBe("IMPORTED");
    expect(readFileSync(join(appDir(), result.previous, "old.db"), "utf8")).toBe("OLD");
    expect(readdirSync(appDir()).filter((n) => n.startsWith("data.importing-"))).toEqual([]);
    const run = env.spawner.calls.find(([f]) => f === SYSTEMD_RUN)!;
    expect(run).toContain("--uid=app-piqo");
    expect(run).toContain("--property=IPAddressDeny=any");
    expect(run.slice(run.indexOf("--") + 1, run.indexOf("--") + 5)).toEqual([env.paths.runtimeNode, "--no-warnings", "-e", IMPORT_JOB]);
    expect(run.at(-1)).toBe("gzip");
    // The app runs during the long part; it's only stopped for the swap.
    const order = [...env.fake.calls.filter(([f, a]) => f === BIN.systemctl && (a === "stop" || a === "start")).map((c) => c[1])];
    expect(order).toEqual(["stop", "start"]);
  });

  it("takes an archive of the folder's contents too, and keeps only the latest replaced folder", async () => {
    mkdirSync(join(appDir(), "data.before-restore-20260101000000"));
    env.spawner.respond = job("");
    const result = await dataImport();
    expect(readFileSync(join(appDir(), "data", "app.db"), "utf8")).toBe("IMPORTED");
    expect(readdirSync(appDir()).filter((n) => n.startsWith("data.before-restore-"))).toEqual([result.previous]);
  });

  it("handles two imports in the same second", async () => {
    env.spawner.respond = job("data");
    const first = await dataImport();
    writeFileSync(join(env.paths.restoreDir, file), GZIP);
    const second = await dataImport();
    expect(second.previous).not.toBe(first.previous);
    expect(readdirSync(appDir()).filter((n) => n.startsWith("data."))).toEqual([second.previous]);
  });

  it("changes nothing when the check fails, and says why", async () => {
    env.spawner.respond = (f, args) => {
      const r = job("data")(f, args);
      return r && { code: 3, output: "layer: app.db failed SQLite's integrity check (database disk image is malformed); data/ is unchanged\n" };
    };
    await expect(dataImport()).rejects.toThrow("app.db failed SQLite's integrity check");
    expect(readFileSync(join(appDir(), "data", "old.db"), "utf8")).toBe("OLD");
    expect(readdirSync(appDir()).filter((n) => n.startsWith("data."))).toEqual([]);
    expect(env.fake.calls.some(([f, a]) => f === BIN.systemctl && a === "stop")).toBe(false);
  });

  it("knows a plain tar from a gzip, and refuses anything else", async () => {
    const tar = Buffer.alloc(512);
    tar.write("ustar", 257, "latin1");
    writeFileSync(join(env.paths.restoreDir, file), tar);
    env.spawner.respond = job("data");
    await dataImport();
    expect(env.spawner.calls.find(([f]) => f === SYSTEMD_RUN)!.at(-1)).toBe("tar");

    writeFileSync(join(env.paths.restoreDir, file), "PK\u0003\u0004 a zip file");
    await expect(dataImport()).rejects.toThrow("isn't a .tar.gz or .tar archive");
    expect(existsSync(join(appDir(), "data", "app.db"))).toBe(true);
  });
});

describe("backup.discard", () => {
  it("removes a staged snapshot", async () => {
    const { file } = await snapshot();
    const result = await backupActions["backup.discard"]!.run({ file }, env.ctx, NO_IO);
    expect(result).toEqual({ file, discarded: true });
    expect(readdirSync(env.paths.stagingDir)).toEqual([]);
  });
});

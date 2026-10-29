import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appActions } from "../src/actions/app.ts";
import { backupActions } from "../src/actions/backup.ts";
import { NO_IO } from "../src/context.ts";
import { BIN } from "../src/exec.ts";
import { RESTORE_JOB, SNAPSHOT_JOB } from "../src/jobs.ts";
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
    expect(env.fake.calls.filter(([f, a]) => f === BIN.systemctl && a === "start")).toHaveLength(2);
  });

  it("only takes plain file names from the restore folder", async () => {
    await expect(restore("../../etc/shadow")).rejects.toThrow(/backup file name/);
    await expect(restore("piqo-20261029030000-ffffffff.tar.gz")).rejects.toThrow(/isn't in/);
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

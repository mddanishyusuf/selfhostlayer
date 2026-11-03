import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appActions } from "../src/actions/app.ts";
import { workerActions } from "../src/actions/worker.ts";
import { NO_IO } from "../src/context.ts";
import { BIN } from "../src/exec.ts";
import { SYSTEMD_RUN } from "../src/sandbox.ts";
import { renderWorkerUnit } from "../src/templates/worker-unit.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
const SHA = "d".repeat(40);
const run = (action: string, params: Record<string, unknown>) => ({ ...workerActions, ...appActions })[action as "worker.write"]!.run(params, env.ctx, NO_IO) as Promise<any>;
const unitFile = (name: string) => join(env.paths.systemdDir, `app-kagaz-worker-${name}.service`);

/** The app's live release, as proxy.set leaves it: current → releases/<sha>. */
function deploy() {
  const appDir = join(env.paths.appsRoot, "kagaz");
  mkdirSync(join(appDir, "releases", SHA, "apps", "api"), { recursive: true });
  symlinkSync(`releases/${SHA}`, join(appDir, "current"));
  return realpathSync(join(appDir, "releases", SHA));
}

beforeEach(async () => {
  env = testEnv();
  await run("app.create", { slug: "kagaz" });
  mkdirSync(join(env.paths.nodeRoot, "24.13.1", "bin"), { recursive: true });
  writeFileSync(join(env.paths.nodeRoot, "24.13.1", "bin", "node"), "");
});
afterEach(() => env.cleanup());

const worker = { slug: "kagaz", name: "queue", nodeVersion: "24.13.1", exec: ["node", "worker.js"] };

describe("worker unit", () => {
  it("runs like the app, from the live release, and restarts when it exits", () => {
    const unit = renderWorkerUnit({ ...worker, rootDir: "apps/api", memoryMaxMb: 384 });
    expect(unit).toContain("WorkingDirectory=/srv/apps/kagaz/current/apps/api\n");
    expect(unit).toContain("User=app-kagaz\n");
    expect(unit).toContain("EnvironmentFile=/etc/layer/apps/kagaz/app.env\n");
    expect(unit).toContain("Environment=NODE_ENV=production\n");
    expect(unit).toContain("ExecStart=/opt/layer/node/24.13.1/bin/node worker.js\n");
    expect(unit).toContain("Restart=always\n");
    expect(unit).toContain("SyslogIdentifier=app-kagaz-worker-queue\n");
    expect(unit).toContain("MemoryMax=384M\n");
    expect(unit).toContain("ProtectSystem=strict\n");
    expect(unit).toContain("ReadWritePaths=/srv/apps/kagaz/data\n");
  });

  it("validates names and commands", () => {
    expect(() => renderWorkerUnit({ ...worker, name: "Queue 1", memoryMaxMb: 256 })).toThrow(/name/);
    expect(() => renderWorkerUnit({ ...worker, exec: ["bash", "-c", "id"], memoryMaxMb: 256 })).toThrow(/argv\[0\]/);
  });
});

describe("worker actions", () => {
  it("worker.write enables it, and starts it only once the app is deployed", async () => {
    expect(await run("worker.write", worker)).toMatchObject({ unit: "app-kagaz-worker-queue.service", started: false });
    expect(readFileSync(unitFile("queue"), "utf8")).toContain("ExecStart=/opt/layer/node/24.13.1/bin/node worker.js");
    expect(env.fake.calls).toContainEqual([BIN.systemctl, "enable", "app-kagaz-worker-queue.service"]);
    expect(env.fake.calls).not.toContainEqual([BIN.systemctl, "restart", "app-kagaz-worker-queue.service"]);

    deploy();
    expect(await run("worker.write", worker)).toMatchObject({ started: true });
    expect(env.fake.calls).toContainEqual([BIN.systemctl, "reset-failed", "app-kagaz-worker-queue.service"]);
    expect(env.fake.calls).toContainEqual([BIN.systemctl, "restart", "app-kagaz-worker-queue.service"]);
  });

  it("needs the app and its Node", async () => {
    await expect(run("worker.write", { ...worker, slug: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(run("worker.write", { ...worker, nodeVersion: "22.1.0" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("worker.control starts, stops and restarts; starting needs a live release", async () => {
    await run("worker.write", worker);
    await expect(run("worker.control", { slug: "kagaz", name: "queue", action: "start" })).rejects.toMatchObject({ code: "not_deployed" });
    await run("worker.control", { slug: "kagaz", name: "queue", action: "stop" });
    expect(env.fake.calls).toContainEqual([BIN.systemctl, "stop", "app-kagaz-worker-queue.service"]);
    deploy();
    await run("worker.control", { slug: "kagaz", name: "queue", action: "start" });
    expect(env.fake.calls).toContainEqual([BIN.systemctl, "start", "app-kagaz-worker-queue.service"]);
    await expect(run("worker.control", { slug: "kagaz", name: "queue", action: "kill" })).rejects.toThrow(/action/);
    await expect(run("worker.control", { slug: "kagaz", name: "other", action: "stop" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("worker.list reports each worker's state from systemd", async () => {
    await run("worker.write", worker);
    await run("worker.write", { ...worker, name: "mailer", exec: ["node", "mailer.js"] });
    env.fake.respond = (file, args) =>
      file === BIN.systemctl && args[0] === "show"
        ? args[1] === "app-kagaz-worker-queue.service"
          ? { code: 0, stdout: "ActiveState=active\nSubState=running\nResult=success\nNRestarts=2\nMemoryCurrent=52428800\nActiveEnterTimestamp=Mon 2026-11-03 18:00:00 UTC\nExecMainStatus=0\n", stderr: "" }
          : { code: 0, stdout: "ActiveState=failed\nSubState=failed\nResult=exit-code\nNRestarts=5\nMemoryCurrent=[not set]\nActiveEnterTimestamp=\nExecMainStatus=1\n", stderr: "" }
        : undefined;
    const { workers } = await run("worker.list", { slug: "kagaz" });
    expect(workers).toEqual([
      { name: "mailer", state: "failed", subState: "failed", result: "exit-code", restarts: 5, memoryBytes: null, since: null, exitStatus: 1 },
      { name: "queue", state: "active", subState: "running", result: "success", restarts: 2, memoryBytes: 52428800, since: "Mon 2026-11-03 18:00:00 UTC", exitStatus: 0 },
    ]);
  });

  it("worker.delete removes it; app.delete removes every worker", async () => {
    await run("worker.write", worker);
    await run("worker.write", { ...worker, name: "mailer" });
    await run("worker.delete", { slug: "kagaz", name: "queue" });
    expect(existsSync(unitFile("queue"))).toBe(false);
    expect(env.fake.calls).toContainEqual([BIN.systemctl, "disable", "--now", "app-kagaz-worker-queue.service"]);
    await expect(run("worker.delete", { slug: "kagaz", name: "queue" })).rejects.toMatchObject({ code: "not_found" });
    await run("app.delete", { slug: "kagaz", keepData: false });
    expect(existsSync(unitFile("mailer"))).toBe(false);
  });
});

describe("app.run", () => {
  const command = { slug: "kagaz", nodeVersion: "24.13.1", exec: ["npm", "run", "migrate:mongo"] };

  it("runs once in the live release as the app, with its env, and returns the exit code", async () => {
    const release = deploy();
    env.spawner.respond = () => ({ code: 3 });
    const res = await run("app.run", { ...command, rootDir: "apps/api" });
    expect(res).toMatchObject({ slug: "kagaz", code: 3, timedOut: false });
    const args = env.spawner.calls.find(([f]) => f === SYSTEMD_RUN)!.slice(1) as string[];
    expect(args).toContain("--unit=layer-run-kagaz.service");
    expect(args).toContain("--uid=app-kagaz");
    expect(args).toContain(`--working-directory=${join(release, "apps", "api")}`);
    expect(args).toContain(`--property=EnvironmentFile=-${join(env.paths.appEtcRoot, "kagaz", "app.env")}`);
    expect(args).toContain("--setenv=NODE_ENV=production");
    expect(args.slice(args.indexOf("--") + 1)).toEqual([join(env.paths.nodeRoot, "24.13.1", "bin", "npm"), "run", "migrate:mongo"]);
  });

  it("refuses before a deploy, a second run at once, and anything but node, npm or npx", async () => {
    await expect(run("app.run", command)).rejects.toMatchObject({ code: "not_deployed" });
    deploy();
    await expect(run("app.run", { ...command, exec: ["bash", "-c", "id"] })).rejects.toThrow(/argv\[0\]/);
    env.fake.respond = (file, args) => (file === BIN.systemctl && args[0] === "is-active" ? { code: 0, stdout: "active\n", stderr: "" } : undefined);
    await expect(run("app.run", command)).rejects.toMatchObject({ code: "busy" });
  });
});

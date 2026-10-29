import { existsSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appActions } from "../src/actions/app.ts";
import { cronActions } from "../src/actions/cron.ts";
import { proxyActions } from "../src/actions/proxy.ts";
import { releaseActions } from "../src/actions/release.ts";
import { NO_IO } from "../src/context.ts";
import { parseCronHistory, type JournalEntry } from "../src/cron-history.ts";
import { BIN } from "../src/exec.ts";
import { renderCronService, renderCronTimer } from "../src/templates/cron-unit.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
const SHA = "c".repeat(40);
const run = (action: string, params: Record<string, unknown>) =>
  ({ ...cronActions, ...appActions, ...proxyActions, ...releaseActions })[action as "cron.write"]!.run(params, env.ctx, NO_IO) as Promise<any>;

beforeEach(async () => {
  env = testEnv();
  await run("app.create", { slug: "piqo" });
  mkdirSync(join(env.paths.nodeRoot, "24.13.1", "bin"), { recursive: true });
  (await import("node:fs")).writeFileSync(join(env.paths.nodeRoot, "24.13.1", "bin", "node"), "");
  env.fake.respond = (file, args) =>
    file === BIN.systemdAnalyze
      ? args.includes("not a calendar")
        ? { code: 1, stdout: "", stderr: "Failed to parse calendar specification 'not a calendar': Invalid argument" }
        : { code: 0, stdout: "  Original form: x\nNormalized form: x\n    Next elapse: Thu 2026-10-29 08:00:00 UTC\n", stderr: "" }
      : undefined;
});
afterEach(() => env.cleanup());

const job = { slug: "piqo", name: "sync", calendar: "*-*-* *:00/15:00", nodeVersion: "24.13.1", exec: ["node", "scripts/sync.js"] };

describe("cron units", () => {
  it("runs the job like the app: its user, env, Node, sandbox, from the live release", async () => {
    const service = renderCronService({ ...job, rootDir: "apps/web", memoryMaxMb: 256, timeoutSec: 600 });
    await expect(service).toMatchFileSnapshot("./__snapshots__/app-piqo-cron-sync.service");
    expect(service).toContain("WorkingDirectory=/srv/apps/piqo/current/apps/web\n");
    expect(service).toContain("User=app-piqo\n");
    expect(service).toContain("ProtectSystem=strict\n");
    expect(service).toContain("TimeoutStartSec=600\n");
  });

  it("schedules with OnCalendar and catches up missed runs after a reboot", () => {
    const timer = renderCronTimer(job);
    expect(timer).toContain("OnCalendar=*-*-* *:00/15:00\n");
    expect(timer).toContain("Persistent=true\n");
    expect(timer).toContain("Unit=app-piqo-cron-sync.service\n");
  });

  it("validates names, schedules and commands", () => {
    expect(() => renderCronTimer({ ...job, name: "Bad Name" })).toThrow(/name/);
    expect(() => renderCronTimer({ ...job, calendar: "daily\nOnBootSec=0" })).toThrow(/calendar/);
    expect(() => renderCronService({ ...job, exec: ["bash", "-c", "id"], memoryMaxMb: 256, timeoutSec: 60 })).toThrow(/argv\[0\]/);
  });
});

describe("cron actions", () => {
  it("cron.write writes both units, enables the timer and returns the next run", async () => {
    const res = await run("cron.write", job);
    expect(res).toMatchObject({ unit: "app-piqo-cron-sync", nextRun: "Thu 2026-10-29 08:00:00 UTC" });
    expect(existsSync(join(env.paths.systemdDir, "app-piqo-cron-sync.timer"))).toBe(true);
    expect(readFileSync(join(env.paths.systemdDir, "app-piqo-cron-sync.service"), "utf8")).toContain("ExecStart=/opt/layer/node/24.13.1/bin/node scripts/sync.js");
    expect(env.fake.calls).toContainEqual([BIN.systemctl, "enable", "--now", "app-piqo-cron-sync.timer"]);
  });

  it("refuses a schedule systemd doesn't accept, before writing anything", async () => {
    await expect(run("cron.write", { ...job, calendar: "not a calendar" })).rejects.toMatchObject({ code: "invalid_schedule" });
    expect(existsSync(join(env.paths.systemdDir, "app-piqo-cron-sync.timer"))).toBe(false);
  });

  it("cron.delete removes the units; app.delete removes every cron of the app", async () => {
    await run("cron.write", job);
    await run("cron.write", { ...job, name: "report" });
    await run("cron.delete", { slug: "piqo", name: "sync" });
    expect(existsSync(join(env.paths.systemdDir, "app-piqo-cron-sync.timer"))).toBe(false);
    await expect(run("cron.delete", { slug: "piqo", name: "sync" })).rejects.toMatchObject({ code: "not_found" });
    await run("app.delete", { slug: "piqo", keepData: false });
    expect(existsSync(join(env.paths.systemdDir, "app-piqo-cron-report.timer"))).toBe(false);
  });

  it("cron.run starts the service without waiting", async () => {
    await run("cron.write", job);
    await run("cron.run", { slug: "piqo", name: "sync" });
    expect(env.fake.calls).toContainEqual([BIN.systemctl, "start", "--no-block", "app-piqo-cron-sync.service"]);
  });
});

describe("current symlink", () => {
  it("proxy.set points /srv/apps/<slug>/current at the live release", async () => {
    mkdirSync(join(env.paths.appsRoot, "piqo", "releases", SHA), { recursive: true });
    await run("release.point", { slug: "piqo", color: "green", sha: SHA });
    await run("proxy.set", { slug: "piqo", color: "green", domains: ["piqo.internal"] });
    expect(readlinkSync(join(env.paths.appsRoot, "piqo", "current"))).toBe(`releases/${SHA}`);
  });
});

describe("parseCronHistory", () => {
  // Shapes captured from journalctl -o json on Ubuntu 24.04 (systemd 255).
  const ts = (s: number) => String(1_793_300_000_000_000 + s * 1_000_000);
  const entries: JournalEntry[] = [
    { __REALTIME_TIMESTAMP: ts(0), MESSAGE: "Started app-piqo-cron-sync.service.", MESSAGE_ID: "39f53479d3a045ac8e11786248231fbf", INVOCATION_ID: "aaa", _PID: "1" },
    { __REALTIME_TIMESTAMP: ts(1), MESSAGE: "synced 42 rows", _SYSTEMD_INVOCATION_ID: "aaa", _PID: "100" },
    { __REALTIME_TIMESTAMP: ts(2), MESSAGE: "app-piqo-cron-sync.service: Deactivated successfully.", MESSAGE_ID: "7ad2d189f7e94e70a38c781354912448", INVOCATION_ID: "aaa", _PID: "1" },
    { __REALTIME_TIMESTAMP: ts(60), MESSAGE: "Started app-piqo-cron-sync.service.", MESSAGE_ID: "39f53479d3a045ac8e11786248231fbf", INVOCATION_ID: "bbb", _PID: "1" },
    // A process that exits fast loses its invocation id: placed by time.
    { __REALTIME_TIMESTAMP: ts(61), MESSAGE: "error: database locked", _PID: "101" },
    { __REALTIME_TIMESTAMP: ts(61), MESSAGE: "app-piqo-cron-sync.service: Main process exited, code=exited, status=3/NOTIMPLEMENTED", MESSAGE_ID: "98e322203f7a4ed290d09fe03c09fe15", INVOCATION_ID: "bbb", EXIT_STATUS: "3", _PID: "1" },
    { __REALTIME_TIMESTAMP: ts(61), MESSAGE: "app-piqo-cron-sync.service: Failed with result 'exit-code'.", MESSAGE_ID: "d9b373ed55a64feb8242e02dbe79a49c", INVOCATION_ID: "bbb", _PID: "1" },
    { __REALTIME_TIMESTAMP: ts(120), MESSAGE: "Started app-piqo-cron-sync.service.", MESSAGE_ID: "39f53479d3a045ac8e11786248231fbf", INVOCATION_ID: "ccc", _PID: "1" },
    { __REALTIME_TIMESTAMP: ts(121), MESSAGE: [104, 105], _SYSTEMD_INVOCATION_ID: "ccc", _PID: "102" },
  ];

  it("groups runs newest first with status, exit code and output", () => {
    const runs = parseCronHistory(entries);
    expect(runs.map((r) => [r.invocation, r.status, r.exitStatus])).toEqual([
      ["ccc", "running", null],
      ["bbb", "failed", 3],
      ["aaa", "success", 0],
    ]);
    expect(runs[2]!.output).toEqual(["synced 42 rows"]);
    expect(runs[1]!.output).toEqual(["error: database locked"]);
    expect(runs[0]!.output).toEqual(["hi"]);
    expect(runs[2]!.finishedAt).toBe(new Date(1_793_300_002_000).toISOString());
  });

  it("limits the number of runs", () => {
    expect(parseCronHistory(entries, 1)).toHaveLength(1);
  });
});

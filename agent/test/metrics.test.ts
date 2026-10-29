import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { metricsActions, procStat } from "../src/actions/metrics.ts";
import { NO_IO } from "../src/context.ts";
import { BIN } from "../src/exec.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
beforeEach(() => (env = testEnv()));
afterEach(() => env.cleanup());

describe("metrics.sample", () => {
  it("adds up both colors of each app, from one systemctl call", async () => {
    env.fake.respond = (f, args) =>
      f === BIN.systemctl && args[0] === "show"
        ? {
            code: 0,
            stderr: "",
            stdout: [
              "Id=app-piqo@blue.service\nCPUUsageNSec=2000000000\nMemoryCurrent=209715200",
              "Id=app-piqo@green.service\nCPUUsageNSec=500000000\nMemoryCurrent=10485760",
              "Id=app-blog@blue.service\nCPUUsageNSec=[not set]\nMemoryCurrent=[not set]",
              "Id=app-blog@green.service\nCPUUsageNSec=[not set]\nMemoryCurrent=[not set]",
            ].join("\n\n"),
          }
        : undefined;
    const r = (await metricsActions["metrics.sample"]!.run({ slugs: ["piqo", "blog"] }, env.ctx, NO_IO)) as any;
    expect(r.apps).toEqual({ piqo: { cpuNs: 2_500_000_000, memoryMb: 210 }, blog: { cpuNs: 0, memoryMb: 0 } });
    expect(env.fake.calls.filter(([f, a]) => f === BIN.systemctl && a === "show")).toHaveLength(1);
    expect(r.box.cpus).toBeGreaterThan(0);
  });

  it("refuses names that aren't apps", async () => {
    await expect(metricsActions["metrics.sample"]!.run({ slugs: ["../etc"] }, env.ctx, NO_IO)).rejects.toThrow();
  });
});

describe("procStat", () => {
  it("counts idle and iowait as not busy", () => {
    expect(procStat("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3")).toEqual({ busy: 150, total: 1000 });
    expect(procStat("")).toEqual({ busy: 0, total: 0 });
  });
});

describe("metrics.disk", () => {
  it("measures each app's folder with du", async () => {
    mkdirSync(join(env.paths.appsRoot, "piqo"), { recursive: true });
    env.fake.respond = (f, args) => (f === BIN.du ? { code: 0, stderr: "", stdout: `${300 * 2 ** 20}\t${args.at(-1)}\n` } : undefined);
    const r = (await metricsActions["metrics.disk"]!.run({ slugs: ["piqo", "gone"] }, env.ctx, NO_IO)) as any;
    expect(r.apps).toEqual({ piqo: 300 });
  });
});

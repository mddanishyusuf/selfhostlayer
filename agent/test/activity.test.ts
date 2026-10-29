import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityActions } from "../src/actions/activity.ts";
import { NO_IO } from "../src/context.ts";
import { tailLines } from "../src/fsutil.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
beforeEach(() => (env = testEnv()));
afterEach(() => env.cleanup());

describe("audit.tail", () => {
  it("pairs each change's start and end, newest first, without the status reads", async () => {
    mkdirSync(dirname(env.paths.auditLog), { recursive: true });
    const line = (o: object) => appendFileSync(env.paths.auditLog, JSON.stringify(o) + "\n");
    line({ ts: "2026-10-29T10:00:00Z", id: "a", action: "app.create", phase: "start", params: { slug: "piqo" } });
    line({ ts: "2026-10-29T10:00:01Z", id: "a", action: "app.create", phase: "end", ok: true, ms: 120 });
    line({ ts: "2026-10-29T10:00:02Z", id: "s", action: "unit.status", phase: "start", params: { slug: "piqo" } });
    line({ ts: "2026-10-29T10:00:02Z", id: "s", action: "unit.status", phase: "end", ok: true, ms: 3 });
    line({ ts: "2026-10-29T10:01:00Z", id: "b", action: "proxy.set", phase: "start", params: { slug: "piqo", domains: ["piqo.app"] } });
    line({ ts: "2026-10-29T10:01:01Z", id: "b", action: "proxy.set", phase: "end", ok: false, code: "invalid_config", ms: 900 });
    line({ ts: "2026-10-29T10:02:00Z", id: "c", action: "build.run", phase: "start", params: { slug: "piqo" } });
    appendFileSync(env.paths.auditLog, "not json\n");
    const { entries } = (await activityActions["audit.tail"]!.run({}, env.ctx, NO_IO)) as any;
    expect(entries.map((e: any) => [e.action, e.ok, e.code])).toEqual([
      ["build.run", null, null],
      ["proxy.set", false, "invalid_config"],
      ["app.create", true, null],
    ]);
  });
});

describe("requests.tail", () => {
  it("reads Caddy's access log, newest first", async () => {
    const log = join(env.paths.caddyLogDir, "piqo.log");
    mkdirSync(dirname(log), { recursive: true });
    const entry = (ts: number, status: number, uri: string) =>
      JSON.stringify({ level: "info", ts, msg: "handled request", request: { remote_ip: "203.0.113.7", client_ip: "203.0.113.7", method: "GET", host: "piqo.app", uri }, duration: 0.0123, size: 512, status });
    writeFileSync(log, [entry(1798500000.5, 200, "/"), "garbage", entry(1798500001, 502, "/api")].join("\n") + "\n");
    const r = (await activityActions["requests.tail"]!.run({ slug: "piqo" }, env.ctx, NO_IO)) as any;
    expect(r.requests).toEqual([
      { at: 1798500001000, status: 502, method: "GET", host: "piqo.app", uri: "/api", ip: "203.0.113.7", ms: 12, bytes: 512 },
      { at: 1798500000500, status: 200, method: "GET", host: "piqo.app", uri: "/", ip: "203.0.113.7", ms: 12, bytes: 512 },
    ]);
    expect(((await activityActions["requests.tail"]!.run({ slug: "nolog" }, env.ctx, NO_IO)) as any).requests).toEqual([]);
  });
});

describe("tailLines", () => {
  it("drops the line cut off at the start", () => {
    const file = join(env.root, "t.log");
    writeFileSync(file, "first line\nsecond\nthird\n");
    expect(tailLines(file, 13)).toEqual(["second", "third"]);
    expect(tailLines(file, 1000)).toEqual(["first line", "second", "third"]);
  });
});

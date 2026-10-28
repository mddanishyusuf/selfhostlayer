import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appActions } from "../src/actions/app.ts";
import { proxyActions } from "../src/actions/proxy.ts";
import { releaseActions } from "../src/actions/release.ts";
import { unitActions } from "../src/actions/unit.ts";
import { NO_IO, type ActionTable } from "../src/context.ts";
import { BIN } from "../src/exec.ts";
import { parseLiveMarker, renderCaddySite } from "../src/templates/caddy-site.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
const all: ActionTable = { ...appActions, ...unitActions, ...releaseActions, ...proxyActions };
const run = (action: keyof typeof all, params: Record<string, unknown>) => all[action]!.run(params, env.ctx, NO_IO) as Promise<any>;

beforeEach(async () => {
  env = testEnv();
  await run("app.create", { slug: "hello" });
  mkdirSync(join(env.paths.appsRoot, "hello", "releases", "abc1234"), { recursive: true });
});
afterEach(() => env.cleanup());

describe("renderCaddySite", () => {
  it("renders the site and a parseable live marker", async () => {
    const site = renderCaddySite({ slug: "hello", color: "green", port: 4001, domains: ["hello.com", "www.hello.com"] });
    await expect(site).toMatchFileSnapshot("./__snapshots__/hello.caddy");
    expect(parseLiveMarker(site)).toEqual({ slug: "hello", color: "green", port: 4001 });
  });

  it("adds a permanent redirect block for each redirect host", () => {
    const site = renderCaddySite({ slug: "hello", color: "blue", port: 4000, domains: ["hello.com"], redirects: [{ from: "www.hello.com", to: "hello.com" }] });
    expect(site).toContain("\nwww.hello.com {\n\tredir https://hello.com{uri} permanent\n}\n");
    expect(site.indexOf("hello.com {")).toBeLessThan(site.indexOf("www.hello.com {"));
  });

  it("rejects redirects to foreign hosts and hosts listed twice", () => {
    const base = { slug: "hello", color: "blue" as const, port: 4000, domains: ["hello.com"] };
    expect(() => renderCaddySite({ ...base, redirects: [{ from: "www.hello.com", to: "evil.com" }] })).toThrow(/site's domains/);
    expect(() => renderCaddySite({ ...base, redirects: [{ from: "hello.com", to: "hello.com" }] })).toThrow(/twice/);
    expect(() => renderCaddySite({ ...base, redirects: [{ from: "www.hello.com {", to: "hello.com" }] })).toThrow(/from/);
  });

  it("validates domains", () => {
    const base = { slug: "hello", color: "blue" as const, port: 4000 };
    expect(() => renderCaddySite({ ...base, domains: [] })).toThrow(/domains/);
    expect(() => renderCaddySite({ ...base, domains: ["a.com", "a.com"] })).toThrow(/duplicates/);
    expect(() => renderCaddySite({ ...base, domains: ["a.com {\n respond hi\n}"] })).toThrow(/domains\[0\]/);
  });
});

describe("release.point", () => {
  it("atomically points a color at a release", async () => {
    await run("release.point", { slug: "hello", color: "blue", sha: "abc1234" });
    expect(readlinkSync(join(env.paths.appsRoot, "hello", "blue"))).toBe("releases/abc1234");
  });

  it("refuses missing releases and the live color", async () => {
    await expect(run("release.point", { slug: "hello", color: "blue", sha: "fff0000" })).rejects.toMatchObject({ code: "not_found" });
    await run("proxy.set", { slug: "hello", color: "blue", domains: ["hello.internal"] });
    await expect(run("release.point", { slug: "hello", color: "blue", sha: "abc1234" })).rejects.toMatchObject({ code: "conflict" });
    await run("release.point", { slug: "hello", color: "green", sha: "abc1234" });
  });
});

describe("proxy.set", () => {
  it("writes the site for the color's port and reloads Caddy", async () => {
    const res = await run("proxy.set", { slug: "hello", color: "green", domains: ["hello.internal"] });
    const site = readFileSync(join(env.paths.caddySitesDir, "hello.caddy"), "utf8");
    expect(site).toContain(`reverse_proxy 127.0.0.1:${res.port}`);
    expect(parseLiveMarker(site)?.color).toBe("green");
    expect(env.fake.calls).toContainEqual([BIN.systemctl, "reload", "caddy"]);
  });

  it("restores the previous site when Caddy refuses the reload", async () => {
    await run("proxy.set", { slug: "hello", color: "blue", domains: ["hello.internal"] });
    const before = readFileSync(join(env.paths.caddySitesDir, "hello.caddy"), "utf8");
    let reloads = 0;
    env.fake.respond = (file, args) =>
      file === BIN.systemctl && args[0] === "reload" && reloads++ === 0 ? { code: 1, stdout: "", stderr: "bad" } : undefined;
    await expect(run("proxy.set", { slug: "hello", color: "green", domains: ["hello.internal"] })).rejects.toMatchObject({
      code: "invalid_config",
    });
    expect(readFileSync(join(env.paths.caddySitesDir, "hello.caddy"), "utf8")).toBe(before);
  });

  it("removes a brand-new site when Caddy refuses it", async () => {
    env.fake.respond = (file, args) => (file === BIN.systemctl && args[0] === "reload" ? { code: 1, stdout: "", stderr: "" } : undefined);
    await expect(run("proxy.set", { slug: "hello", color: "blue", domains: ["hello.internal"] })).rejects.toThrow();
    expect(existsSync(join(env.paths.caddySitesDir, "hello.caddy"))).toBe(false);
  });
});

describe("unit.write / unit.start / unit.stop", () => {
  const exec = ["node", "server.js"];

  it("requires the Node version to be installed", async () => {
    await expect(run("unit.write", { slug: "hello", nodeVersion: "24.13.1", exec })).rejects.toMatchObject({ code: "not_found" });
    mkdirSync(join(env.paths.nodeRoot, "24.13.1", "bin"), { recursive: true });
    writeFileSync(join(env.paths.nodeRoot, "24.13.1", "bin", "node"), "");
    await run("unit.write", { slug: "hello", nodeVersion: "24.13.1", exec });
    expect(readFileSync(join(env.paths.systemdDir, "app-hello@.service"), "utf8")).toContain("ExecStart=/opt/layer/node/24.13.1/bin/node server.js");
  });

  it("won't start a color without a release, or without a unit", async () => {
    await expect(run("unit.start", { slug: "hello", color: "blue" })).rejects.toMatchObject({ code: "not_found" });
    mkdirSync(env.paths.systemdDir, { recursive: true });
    writeFileSync(join(env.paths.systemdDir, "app-hello@.service"), "");
    await expect(run("unit.start", { slug: "hello", color: "blue" })).rejects.toMatchObject({ code: "no_release" });
  });

  it("refuses to stop the live color unless forced", async () => {
    await run("proxy.set", { slug: "hello", color: "blue", domains: ["hello.internal"] });
    await expect(run("unit.stop", { slug: "hello", color: "blue" })).rejects.toMatchObject({ code: "conflict" });
    await run("unit.stop", { slug: "hello", color: "green" });
    await run("unit.stop", { slug: "hello", color: "blue", force: true });
  });
});

describe("app.list", () => {
  it("reads apps back from their files", async () => {
    await run("proxy.set", { slug: "hello", color: "green", domains: ["hello.internal", "www.hello.internal"] });
    const { apps } = await run("app.list", {});
    expect(apps).toEqual([
      expect.objectContaining({ slug: "hello", live: "green", domains: ["hello.internal", "www.hello.internal"], unitFile: false }),
    ]);
  });
});

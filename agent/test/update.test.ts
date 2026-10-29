import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseFeed, UPDATE_UNIT, updateActions } from "../src/actions/update.ts";
import { NO_IO } from "../src/context.ts";
import { BIN } from "../src/exec.ts";
import { SYSTEMD_RUN } from "../src/sandbox.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

const TARBALL = Buffer.from("tarball bytes");
const INSTALLER = Buffer.from("#!/bin/bash\necho installing\n");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let server: Server;
let base = "";
let feed = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/releases.json") return res.writeHead(200, { "Content-Type": "application/json" }).end(feed);
    if (req.url === "/layer-0.2.0.tar.gz") return res.writeHead(200).end(TARBALL);
    if (req.url === "/install.sh") return res.writeHead(200).end(INSTALLER);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const release = (over: Record<string, unknown> = {}) => ({
  version: "0.2.0",
  date: "2026-11-01",
  notes: "Faster deploys.",
  tarball: { url: `${base}/layer-0.2.0.tar.gz`, sha256: sha(TARBALL) },
  installer: { url: `${base}/install.sh`, sha256: sha(INSTALLER) },
  ...over,
});

let env: TestEnv;
beforeEach(() => {
  env = testEnv();
  mkdirSync(dirname(env.paths.boxConfig), { recursive: true });
  writeFileSync(env.paths.boxConfig, JSON.stringify({ panelHost: "p.example.com", appsDomain: "p.example.com", publicIp: "203.0.113.7", version: "0.1.0", defaultNode: "24.13.1", updatesUrl: `${base}/releases.json` }));
  feed = JSON.stringify({ releases: [release()] });
});
afterEach(() => env.cleanup());

const run = (action: "update.check" | "update.start" | "update.status", params: Record<string, unknown> = {}) => updateActions[action]!.run(params, env.ctx, NO_IO) as Promise<any>;

describe("parseFeed", () => {
  it("reads releases, newest first", () => {
    expect(parseFeed(JSON.stringify({ releases: [release()] }))[0]).toMatchObject({ version: "0.2.0", notes: "Faster deploys." });
  });

  it("refuses downloads over plain http from elsewhere, and bad checksums", () => {
    expect(() => parseFeed(JSON.stringify({ releases: [release({ tarball: { url: "http://example.com/x.tar.gz", sha256: sha(TARBALL) } })] }))).toThrow(/https/);
    expect(() => parseFeed(JSON.stringify({ releases: [release({ installer: { url: `${base}/install.sh`, sha256: "abc" } })] }))).toThrow(/sha256/);
    expect(() => parseFeed(JSON.stringify({ releases: [release({ version: "../x" })] }))).toThrow(/version/);
    expect(() => parseFeed("not json")).toThrow(/isn't JSON/);
  });
});

describe("update.check", () => {
  it("compares the feed's newest release with this server's", async () => {
    expect(await run("update.check")).toEqual({ current: "0.1.0", latest: { version: "0.2.0", date: "2026-11-01", notes: "Faster deploys." }, available: true, running: false });
    feed = JSON.stringify({ releases: [release({ version: "0.1.0" })] });
    expect((await run("update.check")).available).toBe(false);
  });
});

describe("update.start", () => {
  it("checks both downloads, then runs the installer in its own unit", async () => {
    const result = await run("update.start", { version: "latest" });
    expect(result).toEqual({ from: "0.1.0", to: "0.2.0", unit: UPDATE_UNIT });
    const dir = join(env.paths.updatesDir, "0.2.0");
    expect(env.fake.calls).toContainEqual([
      SYSTEMD_RUN,
      "--quiet",
      `--unit=${UPDATE_UNIT}`,
      "--description=Self Host Layer update to 0.2.0",
      "--",
      "/bin/bash",
      join(dir, "install.sh"),
      "--from-tarball",
      join(dir, "layer-0.2.0.tar.gz"),
      "--yes",
      "--no-harden-ssh",
    ]);
  });

  it("installs nothing when a checksum doesn't match", async () => {
    feed = JSON.stringify({ releases: [release({ tarball: { url: `${base}/layer-0.2.0.tar.gz`, sha256: "0".repeat(64) } })] });
    await expect(run("update.start", { version: "0.2.0" })).rejects.toThrow("doesn't match the checksum");
    expect(env.fake.calls.some(([f]) => f === SYSTEMD_RUN)).toBe(false);
    expect(existsSync(join(env.paths.updatesDir, "0.2.0"))).toBe(false);
  });

  it("refuses while an update runs, and versions the feed doesn't list", async () => {
    await expect(run("update.start", { version: "9.9.9" })).rejects.toThrow("no release 9.9.9");
    env.fake.respond = (f, args) => (f === BIN.systemctl && args[0] === "is-active" && args[1] === UPDATE_UNIT ? { code: 0, stdout: "active\n", stderr: "" } : undefined);
    await expect(run("update.start", { version: "0.2.0" })).rejects.toThrow("already running");
  });

  it("needs a feed in the config", async () => {
    writeFileSync(env.paths.boxConfig, JSON.stringify({ panelHost: "p.example.com", appsDomain: "x", publicIp: "1.2.3.4", version: "0.1.0", defaultNode: "24.13.1" }));
    await expect(run("update.check")).rejects.toThrow("no update feed");
  });
});

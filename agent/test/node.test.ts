import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { nodeActions } from "../src/actions/node.ts";
import { NO_IO } from "../src/context.ts";
import { BIN } from "../src/exec.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

const TARBALL = Buffer.from("not really a tarball, the fake exec doesn't unpack it");
const integrity = `sha512-${createHash("sha512").update(TARBALL).digest("base64")}`;

let server: Server;
let url = "";
beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(200).end(TARBALL));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/corepack-0.36.0.tgz`;
});
afterAll(() => server.close());

let env: TestEnv;
beforeEach(() => {
  env = testEnv();
  env.paths.corepack = { url, integrity };
});
afterEach(() => env.cleanup());

/** A runtime already on disk, like Node 26 (no corepack) or Node 24 (with it). */
function runtime(version: string, withCorepack: boolean): string {
  const dir = join(env.paths.nodeRoot, version);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "lib", "node_modules"), { recursive: true });
  writeFileSync(join(dir, "bin", "node"), "");
  if (withCorepack) writeFileSync(join(dir, "bin", "corepack"), "");
  return dir;
}
const install = (version: string) => nodeActions["node.install"]!.run({ version }, env.ctx, NO_IO) as Promise<{ installed: boolean; corepack: boolean }>;

describe("corepack for Node versions that don't ship it", () => {
  it("adds it to a Node 26 runtime, laid out like Node 24's", async () => {
    const dir = runtime("26.13.0", false);
    expect(await install("26.13.0")).toMatchObject({ installed: false, corepack: true });
    const tar = env.fake.calls.find(([f]) => f === BIN.tar)!;
    expect(tar.slice(1)).toEqual(["-xzf", expect.stringMatching(/corepack\.tgz$/), "-C", join(dir, "lib", "node_modules", "corepack.partial"), "--strip-components=1", "--no-same-owner"]);
    // Readable and runnable by every app user, whatever the agent's umask made the folders.
    expect(env.fake.calls).toContainEqual([BIN.chmod, "-R", "u=rwX,go=rX", join(dir, "lib", "node_modules", "corepack.partial")]);
    expect(lstatSync(join(dir, "bin", "corepack")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "bin", "corepack"))).toBe("../lib/node_modules/corepack/dist/corepack.js");
  });

  it("leaves a runtime that has it alone", async () => {
    runtime("24.13.1", true);
    expect(await install("24.13.1")).toMatchObject({ corepack: false });
    expect(env.fake.calls.some(([f]) => f === BIN.tar)).toBe(false);
  });

  it("refuses a tarball that doesn't match the pinned hash", async () => {
    const dir = runtime("26.13.0", false);
    env.paths.corepack = { url, integrity: "sha512-AAAA" };
    await expect(install("26.13.0")).rejects.toThrow(/integrity hash/);
    expect(existsSync(join(dir, "bin", "corepack"))).toBe(false);
    expect(env.fake.calls.some(([f]) => f === BIN.tar)).toBe(false);
  });
});

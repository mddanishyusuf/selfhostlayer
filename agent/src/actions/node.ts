import { createHash } from "node:crypto";
import { createWriteStream, existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertNodeVersion } from "@layer/protocol";
import type { ActionTable, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { ensureDir } from "../fsutil.ts";

const MAX_TARBALL_BYTES = 200 * 2 ** 20;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

function nodeArch(): string {
  if (process.arch === "x64" || process.arch === "arm64") return process.arch;
  throw new ActionError("unsupported", `no Node builds for ${process.arch}`);
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) {
    throw new ActionError(res.status === 404 ? "not_found" : "download_failed", `GET ${url}: HTTP ${res.status}`);
  }
  return res;
}

/** Streams url to path, returning its sha256. Aborts past MAX_TARBALL_BYTES. */
export async function download(url: string, path: string): Promise<string> {
  const res = await fetchOk(url);
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      if (bytes > MAX_TARBALL_BYTES) return done(new ActionError("download_failed", "tarball too large"));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), meter, createWriteStream(path, { mode: 0o600 }));
  return hash.digest("hex");
}

/**
 * Node 25 and later don't ship corepack, which builds use to run yarn and
 * pnpm. It's added the way Node 24 lays it out (lib/node_modules/corepack and
 * a bin/corepack link), from a pinned npm tarball checked against its
 * integrity hash. Returns whether it was added.
 */
export async function ensureCorepack(ctx: Context, dir: string): Promise<boolean> {
  const link = join(dir, "bin", "corepack");
  const target = join(dir, "lib", "node_modules", "corepack");
  if (existsSync(link)) return false;
  const { url, integrity } = ctx.paths.corepack;
  const tmp = mkdtempSync(join(tmpdir(), "layer-corepack-"));
  const partial = `${target}.partial`;
  try {
    const file = join(tmp, "corepack.tgz");
    await download(url, file);
    if (`sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}` !== integrity) {
      throw new ActionError("checksum_mismatch", `${url} doesn't match its pinned integrity hash`);
    }
    rmSync(partial, { recursive: true, force: true });
    ensureDir(partial, 0o755);
    await ctx.exec(BIN.tar, ["-xzf", file, "-C", partial, "--strip-components=1", "--no-same-owner"], { timeoutMs: 60_000 });
    // npm tarballs list only files, so tar makes their folders under the
    // agent's umask (077): every app user must be able to read and run them.
    await ctx.exec(BIN.chmod, ["-R", "u=rwX,go=rX", partial]);
    rmSync(target, { recursive: true, force: true });
    renameSync(partial, target);
    // A link left from a broken install points nowhere: replace it.
    if (lstatSync(link, { throwIfNoEntry: false })) rmSync(link);
    symlinkSync("../lib/node_modules/corepack/dist/corepack.js", link);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(partial, { recursive: true, force: true });
  }
  return true;
}

async function nodeInstall(params: Params, ctx: Context) {
  const version = assertNodeVersion(params.version, "version");
  const dest = join(ctx.paths.nodeRoot, version);
  if (existsSync(join(dest, "bin", "node"))) {
    // Runtimes installed before corepack was added for Node 25+ get it now.
    return { version, path: dest, installed: false, corepack: await ensureCorepack(ctx, dest) };
  }

  const tarball = `node-v${version}-linux-${nodeArch()}.tar.xz`;
  const base = `${ctx.paths.nodeDistBase}/v${version}`;
  const sums = await (await fetchOk(`${base}/SHASUMS256.txt`)).text();
  const expected = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === tarball)?.[0];
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new ActionError("not_found", `${tarball} is not listed in SHASUMS256.txt`);
  }

  const tmp = mkdtempSync(join(tmpdir(), "layer-node-"));
  const partial = `${dest}.partial`;
  try {
    const actual = await download(`${base}/${tarball}`, join(tmp, tarball));
    if (actual !== expected) {
      throw new ActionError("checksum_mismatch", `sha256 of ${tarball} doesn't match SHASUMS256.txt`);
    }
    // Unpack beside the target and rename, so a half-extracted runtime never
    // appears at the real path.
    ensureDir(ctx.paths.nodeRoot, 0o755);
    rmSync(partial, { recursive: true, force: true });
    ensureDir(partial, 0o755);
    await ctx.exec(BIN.tar, ["-xJf", join(tmp, tarball), "-C", partial, "--strip-components=1", "--no-same-owner"], {
      timeoutMs: 5 * 60_000,
    });
    await ctx.exec(BIN.chmod, ["-R", "go-w", partial]);
    await ensureCorepack(ctx, partial);
    renameSync(partial, dest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(partial, { recursive: true, force: true });
  }
  return { version, path: dest, installed: true };
}

export const nodeActions: ActionTable = {
  "node.install": { mutates: true, run: nodeInstall },
};

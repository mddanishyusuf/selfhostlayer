import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertNodeVersion, ValidationError } from "@layer/protocol";
import type { ActionTable, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { ensureDir } from "../fsutil.ts";

// Build tools that don't ship with Node. Each is an official release binary,
// checked against the release's SHASUMS256.txt, installed read-only like Node.
const TOOLS = ["bun"] as const;
type Tool = (typeof TOOLS)[number];

/** bun's "baseline" x64 build runs on every x86-64 CPU (the default one needs AVX2). */
export function bunAsset(arch: string): string {
  if (arch === "x64") return "bun-linux-x64-baseline.zip";
  if (arch === "arm64") return "bun-linux-aarch64.zip";
  throw new ActionError("unsupported", `no bun build for ${arch}`);
}

async function download(url: string, path: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok || !res.body) throw new ActionError(res.status === 404 ? "not_found" : "download_failed", `GET ${url}: HTTP ${res.status}`);
  const hash = createHash("sha256");
  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  body.on("data", (chunk: Buffer) => hash.update(chunk));
  await pipeline(body, createWriteStream(path, { mode: 0o600 }));
  return hash.digest("hex");
}

async function toolInstall(params: Params, ctx: Context) {
  const tool = params.tool as Tool;
  if (!TOOLS.includes(tool)) throw new ValidationError("tool", `must be one of ${TOOLS.join(", ")}`);
  const version = assertNodeVersion(params.version, "version");
  const dest = join(ctx.paths.toolsRoot, tool, version);
  if (existsSync(join(dest, tool))) return { tool, version, path: dest, installed: false };

  const asset = bunAsset(process.arch);
  const base = `https://github.com/oven-sh/bun/releases/download/bun-v${version}`;
  const sumsRes = await fetch(`${base}/SHASUMS256.txt`, { signal: AbortSignal.timeout(60_000) });
  if (!sumsRes.ok) throw new ActionError(sumsRes.status === 404 ? "not_found" : "download_failed", `bun ${version}: HTTP ${sumsRes.status}`);
  const expected = (await sumsRes.text())
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0];
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new ActionError("not_found", `${asset} isn't listed for bun ${version}`);

  const tmp = mkdtempSync(join(tmpdir(), "layer-tool-"));
  const partial = `${dest}.partial`;
  try {
    const actual = await download(`${base}/${asset}`, join(tmp, asset));
    if (actual !== expected) throw new ActionError("checksum_mismatch", `sha256 of ${asset} doesn't match SHASUMS256.txt`);
    ensureDir(join(ctx.paths.toolsRoot, tool), 0o755);
    rmSync(partial, { recursive: true, force: true });
    ensureDir(partial, 0o755);
    // -j: the zip holds one folder with the binary; keep just the binary.
    await ctx.exec(BIN.unzip, ["-q", "-j", "-o", join(tmp, asset), "-d", partial]);
    await ctx.exec(BIN.chmod, ["-R", "go-w", partial]);
    await ctx.exec(BIN.chmod, ["755", join(partial, tool)]);
    renameSync(partial, dest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(partial, { recursive: true, force: true });
  }
  return { tool, version, path: dest, installed: true };
}

export const toolActions: ActionTable = {
  "tool.install": { mutates: true, run: toolInstall },
};

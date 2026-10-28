// Source fetch, builds and cleanup inside an app's tree.
//
// Rule: root never touches files inside /srv/apps/<slug>/ while the app can
// run, because the app user could swap any folder there for a symlink. Every
// file operation here (unpack, build, prune, cache cleanup) runs as the app
// user in a sandboxed transient unit. Root only downloads, and the tarball
// reaches the unpacker through stdin, never as a shared file.
import { existsSync, lstatSync, readdirSync, readlinkSync, statfsSync } from "node:fs";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import {
  assertCommand,
  assertFullSha,
  assertGithubOwner,
  assertGithubRepo,
  assertInt,
  assertNodeVersion,
  assertPackageManager,
  assertRelativePath,
  assertSlug,
  COLORS,
  ValidationError,
} from "@layer/protocol";
import type { ActionTable, CallIO, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { lookupUser } from "../fsutil.ts";
import { sandboxArgs, SYSTEMD_RUN, type SandboxOptions } from "../sandbox.ts";
import { appLayout } from "./app.ts";

const MAX_SOURCE_BYTES = 500 * 2 ** 20;
// GitHub tokens: legacy installation tokens are ghs_ + ~36 chars of
// [A-Za-z0-9_]; since 2026-10 they're stateless ghs_<appid>_<JWT>, ~520 chars
// with dots and dashes (base64url). Allow both, and room to grow.
const TOKEN = /^gh[a-z]_[A-Za-z0-9_.-]{20,4096}$/;

export const tarballUrl = (owner: string, repo: string, sha: string) =>
  `https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`;

/** GitHub answers the tarball request with a 302 to codeload; nothing else is followed. */
export function allowedSourceRedirect(location: string | null): URL | null {
  if (!location) return null;
  try {
    const url = new URL(location);
    return url.protocol === "https:" && url.hostname === "codeload.github.com" ? url : null;
  } catch {
    return null;
  }
}

/** Unit names for one app's jobs, so build.cancel can find them. */
export const jobUnits = (slug: string) => ({ fetch: `layer-fetch-${slug}.service`, build: `layer-build-${slug}.service` });

async function requireAppUser(ctx: Context, slug: string) {
  const app = appLayout(ctx, slug);
  const user = await lookupUser(ctx.exec, app.user);
  if (!user || !existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  return { app, user };
}

/** True for a real directory, never for a symlink to one. */
function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function diskGuard(ctx: Context): void {
  const fs = statfsSync(ctx.paths.appsRoot);
  const free = fs.bavail / fs.blocks;
  const min = ctx.paths.minFreeDisk;
  if (free < min) {
    throw new ActionError("disk_full", `only ${Math.round(free * 100)}% disk free (builds need ${Math.round(min * 100)}%); free some space or run cache.clean`);
  }
}

/** Runs one sandboxed job, streaming its output. Returns the exit code. */
async function runJob(ctx: Context, io: CallIO, opts: SandboxOptions, stdin?: Readable): Promise<number> {
  await ctx.exec(BIN.systemctl, ["reset-failed", opts.unit], { allowFail: true });
  const stop = () => void ctx.exec(BIN.systemctl, ["stop", opts.unit], { allowFail: true });
  // The client went away: stopping systemd-run alone wouldn't stop the unit.
  io.signal.addEventListener("abort", stop, { once: true });
  try {
    const { code } = await ctx.spawn(SYSTEMD_RUN, sandboxArgs(opts), { onData: io.emit, stdin });
    return code;
  } finally {
    io.signal.removeEventListener("abort", stop);
  }
}

// Builds stopped through build.cancel, so their failure reads "cancelled".
const cancelled = new Set<string>();

async function sourceFetch(params: Params, ctx: Context, io: CallIO) {
  const slug = assertSlug(params.slug);
  const owner = assertGithubOwner(params.owner);
  const repo = assertGithubRepo(params.repo);
  const sha = assertFullSha(params.sha);
  const token = params.token;
  if (token !== undefined && (typeof token !== "string" || !TOKEN.test(token))) {
    throw new ValidationError("token", "must be a GitHub token");
  }
  const { app, user } = await requireAppUser(ctx, slug);
  if (isRealDir(join(app.releases, sha))) return { slug, sha, fetched: false };
  diskGuard(ctx);
  cancelled.delete(slug);
  const started = Date.now();

  // 1. Ask GitHub for the archive. The token goes only to api.github.com.
  const res = await fetch(tarballUrl(owner, repo, sha), {
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "self-host-layer",
      ...(typeof token === "string" ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  await res.body?.cancel();
  if (res.status === 404) throw new ActionError("not_found", `${owner}/${repo}@${sha.slice(0, 7)} not found (private repos need the GitHub App connected)`);
  if (res.status === 401 || res.status === 403) throw new ActionError("auth_failed", `GitHub refused access to ${owner}/${repo} (HTTP ${res.status})`);
  const location = allowedSourceRedirect(res.headers.get("location"));
  if (res.status !== 302 || !location) throw new ActionError("download_failed", `unexpected answer from GitHub: HTTP ${res.status}`);

  // 2. Stream the archive from codeload straight into tar, running as the app user.
  const download = await fetch(location, { redirect: "error", signal: AbortSignal.timeout(10 * 60_000) });
  if (!download.ok || !download.body) throw new ActionError("download_failed", `downloading the source failed: HTTP ${download.status}`);
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      if (bytes > MAX_SOURCE_BYTES) return done(new Error("source archive is larger than 500MB"));
      done(null, chunk);
    },
  });
  const stdin = Readable.fromWeb(download.body as import("node:stream/web").ReadableStream).pipe(meter);

  io.emit(`::layer::step fetch\n`);
  const unpack = 'rm -rf -- "$1.partial" && mkdir -- "$1.partial" && tar -xzf - -C "$1.partial" --strip-components=1 --no-same-owner && rm -rf -- "$1" && mv -- "$1.partial" "$1"';
  const code = await runJob(
    ctx,
    io,
    {
      unit: jobUnits(slug).fetch,
      user: user.name,
      cwd: app.releases,
      readWrite: [app.releases],
      env: { PATH: "/usr/bin:/bin" },
      memoryMb: 512,
      timeoutSec: 600,
      network: false,
      command: ["/bin/sh", "-c", unpack, "layer-unpack", sha],
    },
    stdin,
  );
  // Before the exit code: a stopped job can exit "cleanly" (see buildRun).
  if (cancelled.delete(slug)) throw new ActionError("cancelled", "fetch cancelled");
  if (code !== 0) {
    throw new ActionError("fetch_failed", `unpacking ${owner}/${repo}@${sha.slice(0, 7)} failed (exit ${code})`);
  }
  if (!isRealDir(join(app.releases, sha))) throw new ActionError("fetch_failed", "the unpacked release is missing");
  return { slug, sha, fetched: true, bytes, ms: Date.now() - started };
}

/**
 * The script each build step runs, as the app user. Constant: project settings
 * reach it only through env vars. It creates yarn/pnpm shims (corepack), picks
 * the install command from the package manager, and falls back from `npm ci`
 * to `npm install` when the lockfile is out of sync (npm 11 can write lockfiles
 * that its own `npm ci` rejects).
 */
export const BUILD_SCRIPT = `set -euo pipefail
mkdir -p "$LAYER_CACHE/bin" "$HOME"
for pm in yarn pnpm; do
  printf '#!/bin/sh\\nexec corepack %s "$@"\\n' "$pm" > "$LAYER_CACHE/bin/$pm"
  chmod 755 "$LAYER_CACHE/bin/$pm"
done
case "$1" in
  install)
    if [ -n "\${LAYER_INSTALL_CMD:-}" ]; then echo "$ $LAYER_INSTALL_CMD"; exec bash -c "$LAYER_INSTALL_CMD"; fi
    case "$LAYER_PM" in
      npm)
        if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
          echo "$ npm ci"
          if npm ci 2>&1 | tee /tmp/layer-npm-ci.log; then exit 0; fi
          if grep -q "in sync" /tmp/layer-npm-ci.log; then
            echo "layer: package-lock.json is out of sync with package.json, falling back to npm install."
            echo "layer: to fix it, run npm install locally and commit the updated package-lock.json."
            echo "$ npm install"; exec npm install
          fi
          exit 1
        fi
        echo "$ npm install"; exec npm install ;;
      yarn)
        if [ -f .yarnrc.yml ]; then echo "$ yarn install --immutable"; exec yarn install --immutable; fi
        echo "$ yarn install --frozen-lockfile"; exec yarn install --frozen-lockfile --non-interactive ;;
      pnpm) echo "$ pnpm install --frozen-lockfile"; exec pnpm install --frozen-lockfile ;;
      bun) echo "$ bun install --frozen-lockfile"; exec bun install --frozen-lockfile ;;
    esac ;;
  build) echo "$ $LAYER_BUILD_CMD"; exec bash -c "$LAYER_BUILD_CMD" ;;
esac
`;

/** Newest installed version of a tool, e.g. /opt/layer/tools/bun/1.3.9. */
function newestTool(ctx: Context, tool: string): string | null {
  const dir = join(ctx.paths.toolsRoot, tool);
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir)
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return versions.length ? join(dir, versions.at(-1)!) : null;
}

async function buildRun(params: Params, ctx: Context, io: CallIO) {
  const slug = assertSlug(params.slug);
  const sha = assertFullSha(params.sha);
  const nodeVersion = assertNodeVersion(params.nodeVersion);
  const pm = assertPackageManager(params.packageManager);
  const rootDir = params.rootDir === undefined || params.rootDir === "" ? null : assertRelativePath(params.rootDir, "rootDir");
  const installCommand = params.installCommand === undefined ? null : assertCommand(params.installCommand, "installCommand");
  const buildCommand = params.buildCommand === undefined ? null : assertCommand(params.buildCommand, "buildCommand");
  const memoryMb = assertInt(params.memoryMb ?? 1536, "memoryMb", 256, 16384);
  const timeoutSec = assertInt(params.timeoutSec ?? 1200, "timeoutSec", 30, 7200);

  const { app, user } = await requireAppUser(ctx, slug);
  const release = join(app.releases, sha);
  if (!isRealDir(release)) throw new ActionError("not_found", `release ${sha.slice(0, 7)} isn't fetched yet (run source.fetch first)`);
  const nodeBin = join(ctx.paths.nodeRoot, nodeVersion, "bin");
  if (!existsSync(join(nodeBin, "node"))) throw new ActionError("not_found", `Node ${nodeVersion} isn't installed (run node.install first)`);
  const bunDir = pm === "bun" ? newestTool(ctx, "bun") : null;
  if (pm === "bun" && !bunDir) throw new ActionError("tool_missing", "bun isn't installed (run tool.install with tool bun)");
  diskGuard(ctx);
  cancelled.delete(slug);

  const cache = app.cache;
  const env: Record<string, string> = {
    HOME: join(cache, "home"),
    PATH: [nodeBin, join(cache, "bin"), ...(bunDir ? [bunDir] : []), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    LAYER_CACHE: cache,
    LAYER_PM: pm,
    npm_config_cache: join(cache, "npm"),
    npm_config_store_dir: join(cache, "pnpm-store"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    YARN_CACHE_FOLDER: join(cache, "yarn"),
    COREPACK_HOME: join(cache, "corepack"),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    BUN_INSTALL_CACHE_DIR: join(cache, "bun"),
    XDG_CACHE_HOME: join(cache, "xdg"),
    CI: "1",
    FORCE_COLOR: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    NUXT_TELEMETRY_DISABLED: "1",
    ASTRO_TELEMETRY_DISABLED: "1",
    ...(installCommand ? { LAYER_INSTALL_CMD: installCommand } : {}),
    ...(buildCommand ? { LAYER_BUILD_CMD: buildCommand } : {}),
  };
  const workdir = rootDir ? join(release, rootDir) : release;
  const deadline = Date.now() + timeoutSec * 1000;
  const steps: { name: string; ms: number }[] = [];

  for (const step of buildCommand ? ["install", "build"] : ["install"]) {
    const remaining = Math.floor((deadline - Date.now()) / 1000);
    if (remaining < 1) throw new ActionError("timeout", `build timed out after ${timeoutSec}s`);
    io.emit(`::layer::step ${step}\n`);
    const started = Date.now();
    const code = await runJob(ctx, io, {
      unit: jobUnits(slug).build,
      user: user.name,
      cwd: workdir,
      readWrite: [release, cache],
      env,
      // The app's own env (root-only file): NEXT_PUBLIC_* etc. are needed at build time.
      envFiles: [app.appEnv],
      memoryMb,
      timeoutSec: remaining,
      network: true,
      command: ["/bin/bash", "-c", BUILD_SCRIPT, "layer-build", step],
    });
    steps.push({ name: step, ms: Date.now() - started });
    io.emit(`::layer::step-end ${step} ${code} ${Date.now() - started}\n`);
    // Checked before the exit code: systemd counts the SIGTERM from
    // `systemctl stop` as a clean exit, so a cancelled job can report 0.
    if (cancelled.delete(slug)) throw new ActionError("cancelled", "build cancelled");
    if (code !== 0) {
      if (Date.now() >= deadline - 1000) throw new ActionError("timeout", `build timed out after ${timeoutSec}s`);
      throw new ActionError(`${step}_failed`, `${step === "install" ? "installing dependencies" : "the build"} failed (exit ${code})`);
    }
  }
  return { slug, sha, steps };
}

async function buildCancel(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const units = jobUnits(slug);
  let running = false;
  for (const unit of [units.fetch, units.build]) {
    const { stdout } = await ctx.exec(BIN.systemctl, ["is-active", unit], { allowFail: true });
    if (["active", "activating"].includes(stdout.trim())) {
      running = true;
      cancelled.add(slug);
      await ctx.exec(BIN.systemctl, ["stop", unit], { allowFail: true });
    }
  }
  return { slug, cancelled: running };
}

export interface ReleaseEntry {
  name: string;
  mtimeMs: number;
}

/** Which release folders to delete: beyond the newest `keep`, never a color's target; leftovers always. */
export function pickPrunable(entries: ReleaseEntry[], live: Set<string>, keep: number): string[] {
  const partial = entries.filter((e) => e.name.endsWith(".partial")).map((e) => e.name);
  const releases = entries.filter((e) => /^[0-9a-f]{40}$/.test(e.name)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const old = releases.slice(keep).map((e) => e.name).filter((n) => !live.has(n));
  return [...partial, ...old];
}

async function releasePrune(params: Params, ctx: Context, io: CallIO) {
  const slug = assertSlug(params.slug);
  const keep = assertInt(params.keep ?? 5, "keep", 1, 50);
  const { app, user } = await requireAppUser(ctx, slug);
  const live = new Set<string>();
  for (const color of COLORS) {
    try {
      live.add(basename(readlinkSync(join(app.appDir, color))));
    } catch {
      // That color doesn't point anywhere yet.
    }
  }
  // Only names and times are read here (lstat, no following); deleting happens as the app user.
  const entries = readdirSync(app.releases).map((name) => ({ name, mtimeMs: lstatSync(join(app.releases, name)).mtimeMs }));
  const remove = pickPrunable(entries, live, keep);
  if (remove.length > 0) {
    const code = await runJob(ctx, io, {
      unit: `layer-prune-${slug}.service`,
      user: user.name,
      cwd: app.releases,
      readWrite: [app.releases],
      env: { PATH: "/usr/bin:/bin" },
      memoryMb: 256,
      timeoutSec: 600,
      network: false,
      command: ["/bin/rm", "-rf", "--", ...remove],
    });
    if (code !== 0) throw new ActionError("prune_failed", `removing old releases failed (exit ${code})`);
  }
  return { slug, removed: remove, kept: entries.length - remove.length };
}

async function cacheClean(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const maxMb = assertInt(params.maxMb ?? 1024, "maxMb", 0, 102400);
  const { app, user } = await requireAppUser(ctx, slug);
  let output = "";
  // Package caches only; corepack's package-manager downloads and the shims stay.
  const script = `before=$(du -sm . | cut -f1); if [ "$before" -gt "$1" ]; then rm -rf -- npm yarn pnpm-store bun xdg home/.cache; fi; echo "before=$before after=$(du -sm . | cut -f1)"`;
  const code = await runJob(
    ctx,
    { emit: (chunk) => (output += chunk), signal: new AbortController().signal },
    {
      unit: `layer-cache-${slug}.service`,
      user: user.name,
      cwd: app.cache,
      readWrite: [app.cache],
      env: { PATH: "/usr/bin:/bin" },
      memoryMb: 256,
      timeoutSec: 600,
      network: false,
      command: ["/bin/sh", "-c", script, "layer-cache", String(maxMb)],
    },
  );
  const match = /before=(\d+) after=(\d+)/.exec(output);
  if (code !== 0 || !match) throw new ActionError("cache_failed", `cleaning the cache failed (exit ${code})`);
  return { slug, beforeMb: Number(match[1]), afterMb: Number(match[2]), maxMb };
}

export const buildActions: ActionTable = {
  "source.fetch": {
    mutates: true,
    lock: "build",
    run: sourceFetch,
    redact: (p) => ({ ...p, token: p.token === undefined ? undefined : "[redacted]" }),
  },
  "build.run": { mutates: true, lock: "build", run: buildRun },
  // No lock: it must be able to stop a build that holds the build lock.
  "build.cancel": { mutates: false, run: buildCancel },
  "release.prune": { mutates: true, run: releasePrune },
  "cache.clean": { mutates: true, run: cacheClean },
};

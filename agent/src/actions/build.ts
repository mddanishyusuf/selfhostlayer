// Source fetch, builds and cleanup inside an app's tree.
//
// Rule: root never touches files inside /srv/apps/<slug>/ while the app can
// run, because the app user could swap any folder there for a symlink. Every
// file operation here (unpack, build, prune, cache cleanup) runs as the app
// user in a sandboxed transient unit. Root only downloads, and the tarball
// reaches the unpacker through stdin, never as a shared file.
import { createReadStream, existsSync, lstatSync, readdirSync, readlinkSync, rmSync, statfsSync, statSync } from "node:fs";
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
  assertPrivateFiles,
  assertRelativePath,
  assertSlug,
  COLORS,
  ValidationError,
} from "@layer/protocol";
import type { ActionTable, CallIO, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { ensureDir, lookupUser } from "../fsutil.ts";
import { sandboxArgs, SYSTEMD_RUN, type SandboxOptions } from "../sandbox.ts";
import { meetsMinimum } from "../version.ts";
import { appLayout } from "./app.ts";
import { catalogVersion } from "./catalog.ts";
import { download } from "./node.ts";
import { readBox } from "./panel.ts";

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

export function diskGuard(ctx: Context): void {
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

/** Whether systemd says the job's unit, run since `sinceMs`, ended killed for memory. */
async function outOfMemory(ctx: Context, unit: string, sinceMs: number): Promise<boolean> {
  const { stdout } = await ctx.exec(
    BIN.journalctl,
    ["--no-pager", "--output=cat", `--unit=${unit}`, `--since=@${Math.floor(sinceMs / 1000)}`, "--lines=200"],
    { allowFail: true },
  );
  return /result 'oom-kill'|killed by the OOM killer/.test(stdout);
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
 * A catalog app's release (an integration): root downloads the tarball into
 * its own folder and checks it against the catalog's sha256 before anything
 * is unpacked; then it reaches the unpacker through stdin, as a GitHub source
 * does. Catalog apps ship built, so no build step follows. Releases are named
 * by the checksum cut to a commit's length, so deployments, release.point and
 * pruning treat them like GitHub releases.
 */
async function catalogFetch(params: Params, ctx: Context, io: CallIO) {
  const slug = assertSlug(params.slug);
  const named = params.release === undefined ? null : assertFullSha(params.release, "release");
  const { app, user } = await requireAppUser(ctx, slug);
  // A redeploy or rollback of a release still on disk doesn't need the catalog.
  if (named && isRealDir(join(app.releases, named))) return { slug, release: named, fetched: false };
  const want = await catalogVersion(ctx, String(params.app ?? ""), String(params.version ?? ""));
  const label = `${want.manifest.id} ${want.version}`;
  const release = want.tarball.sha256.slice(0, 40);
  if (named && named !== release) throw new ActionError("catalog_changed", `the catalog's ${label} isn't the file this deployment was made for, so nothing was installed`);
  const version = readBox(ctx).version;
  if (want.minPanel && !meetsMinimum(version, want.minPanel)) {
    throw new ActionError("too_old", `${label} needs Self Host Layer ${want.minPanel} or newer (this server runs ${version}): update first`);
  }
  if (isRealDir(join(app.releases, release))) return { slug, release, fetched: false };
  diskGuard(ctx);
  cancelled.delete(slug);
  const started = Date.now();
  ensureDir(ctx.paths.catalogDir, 0o700);
  const file = join(ctx.paths.catalogDir, `${slug}-${release}.tar.gz`);
  try {
    io.emit(`::layer::step fetch\n`);
    io.emit(`Downloading ${label}…\n`);
    if ((await download(want.tarball.url, file)) !== want.tarball.sha256) {
      throw new ActionError("checksum_mismatch", `${label} doesn't match the checksum in the catalog; nothing was installed`);
    }
    const bytes = statSync(file).size;
    const unpack = 'rm -rf -- "$1.partial" && mkdir -- "$1.partial" && tar -xzf - -C "$1.partial" --strip-components=1 --no-same-owner && rm -rf -- "$1" && mv -- "$1.partial" "$1"';
    const tarball = createReadStream(file);
    // The job reports its own failure; a read error (the job ended early) must not crash the agent.
    tarball.on("error", () => {});
    let code: number;
    try {
      code = await runJob(
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
          command: ["/bin/sh", "-c", unpack, "layer-unpack", release],
        },
        tarball,
      );
    } finally {
      tarball.destroy();
    }
    if (cancelled.delete(slug)) throw new ActionError("cancelled", "fetch cancelled");
    if (code !== 0) throw new ActionError("fetch_failed", `unpacking ${label} failed (exit ${code})`);
    if (!isRealDir(join(app.releases, release))) throw new ActionError("fetch_failed", "the unpacked release is missing");
    return { slug, release, fetched: true, bytes, ms: Date.now() - started };
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * The script each build step runs, as the app user. Constant: project settings
 * reach it only through env vars. It creates yarn/pnpm shims (corepack), picks
 * the install command from the package manager, and when a frozen install fails
 * only because the lockfile is out of date with package.json, installs without
 * freezing it, as Vercel does (npm 11 can even write lockfiles its own `npm ci`
 * rejects).
 */
export const BUILD_SCRIPT = `set -euo pipefail
mkdir -p "$LAYER_CACHE/bin" "$HOME"
for pm in yarn pnpm; do
  printf '#!/bin/sh\\nexec corepack %s "$@"\\n' "$pm" > "$LAYER_CACHE/bin/$pm"
  chmod 755 "$LAYER_CACHE/bin/$pm"
done
# try <pattern> <command...>: prints and runs a frozen install, keeping its
# output. Returns 0 when it worked, 2 when it failed only because the lockfile
# is out of date with package.json (the pattern), 1 for anything else.
try() {
  local pattern="$1"
  shift
  echo "$ $*"
  if "$@" 2>&1 | tee /tmp/layer-install.log; then return 0; fi
  if grep -qE "$pattern" /tmp/layer-install.log; then return 2; fi
  return 1
}
# Like Vercel, an out-of-date lockfile doesn't stop the build: it installs
# without freezing, so the lockfile changes only inside this build.
stale() {
  echo "layer: $1 is out of sync with package.json, falling back to $2."
  echo "layer: to fix it, install locally and commit the updated $1."
}
case "$1" in
  install)
    if [ -n "\${LAYER_INSTALL_CMD:-}" ]; then echo "$ $LAYER_INSTALL_CMD"; exec bash -c "$LAYER_INSTALL_CMD"; fi
    rc=0
    case "$LAYER_PM" in
      npm)
        if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
          try "in sync" npm ci || rc=$?
          [ "$rc" = 2 ] || exit "$rc"
          stale package-lock.json "npm install"; echo "$ npm install"; exec npm install
        fi
        echo "$ npm install"; exec npm install ;;
      yarn)
        if [ -f .yarnrc.yml ]; then
          try "YN0028" yarn install --immutable || rc=$?
          [ "$rc" = 2 ] || exit "$rc"
          stale yarn.lock "yarn install --no-immutable"; echo "$ yarn install --no-immutable"; exec yarn install --no-immutable
        fi
        try "lockfile needs to be updated" yarn install --frozen-lockfile --non-interactive || rc=$?
        [ "$rc" = 2 ] || exit "$rc"
        stale yarn.lock "yarn install"; echo "$ yarn install"; exec yarn install --non-interactive ;;
      pnpm)
        try "ERR_PNPM_OUTDATED_LOCKFILE" pnpm install --frozen-lockfile || rc=$?
        [ "$rc" = 2 ] || exit "$rc"
        stale pnpm-lock.yaml "pnpm install --no-frozen-lockfile"; echo "$ pnpm install --no-frozen-lockfile"; exec pnpm install --no-frozen-lockfile ;;
      bun)
        try "lockfile had changes" bun install --frozen-lockfile || rc=$?
        [ "$rc" = 2 ] || exit "$rc"
        stale bun.lock "bun install"; echo "$ bun install"; exec bun install ;;
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
    // pnpm's store, for pnpm only: npm warns about a setting it doesn't know.
    ...(pm === "pnpm" ? { npm_config_store_dir: join(cache, "pnpm-store") } : {}),
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
      const what = step === "install" ? "installing dependencies" : "the build";
      // The kernel kills a worker (Next.js's next-build), and its parent just exits 1.
      if (await outOfMemory(ctx, jobUnits(slug).build, started)) {
        throw new ActionError(`${step}_failed`, `${what} ran out of memory (its limit is ${memoryMb} MB)`);
      }
      throw new ActionError(`${step}_failed`, `${what} failed (exit ${code})`);
    }
  }
  return { slug, sha, steps };
}

/**
 * Writes the project's private files into a fetched release, relative to its
 * root (rootDir), as the app in a sandboxed job: a symlink in the repo can
 * only lead where the app may write anyway. The files come on stdin, never in
 * arguments or logs, and are the app's alone (600). Run before the build, so
 * the build and the app both find them.
 */
const PLACE_FILES_JOB = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  for (const f of JSON.parse(input)) {
    const target = path.join(root, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.rmSync(target, { force: true });
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeSync(fd, f.content);
    fs.closeSync(fd);
    console.log("  " + f.path);
  }
});
`;

async function filesPlace(params: Params, ctx: Context, io: CallIO) {
  const slug = assertSlug(params.slug);
  const sha = assertFullSha(params.sha);
  const rootDir = params.rootDir === undefined || params.rootDir === "" ? null : assertRelativePath(params.rootDir, "rootDir");
  const files = assertPrivateFiles(params.files);
  if (files.length === 0) return { slug, sha, placed: 0 };
  const { app, user } = await requireAppUser(ctx, slug);
  const release = join(app.releases, sha);
  if (!isRealDir(release)) throw new ActionError("not_found", `release ${sha.slice(0, 7)} isn't fetched yet (run source.fetch first)`);
  const code = await runJob(
    ctx,
    io,
    {
      unit: jobUnits(slug).build,
      user: user.name,
      cwd: release,
      readWrite: [release],
      env: { PATH: "/usr/bin:/bin" },
      memoryMb: 256,
      timeoutSec: 60,
      network: false,
      command: [ctx.paths.runtimeNode, "--no-warnings", "-e", PLACE_FILES_JOB, rootDir ? join(release, rootDir) : release],
    },
    Readable.from([JSON.stringify(files)]),
  );
  if (code !== 0) throw new ActionError("files_failed", `writing the private files failed (exit ${code})`);
  return { slug, sha, placed: files.length };
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
  "catalog.fetch": { mutates: true, lock: "build", run: catalogFetch },
  "build.run": { mutates: true, lock: "build", run: buildRun },
  // Never write the files' contents to the audit log.
  "files.place": {
    mutates: true,
    run: filesPlace,
    redact: (params) => ({ slug: params.slug, sha: params.sha, paths: Array.isArray(params.files) ? params.files.map((f: { path?: unknown }) => f?.path) : [] }),
  },
  // No lock: it must be able to stop a build that holds the build lock.
  "build.cancel": { mutates: false, run: buildCancel },
  "release.prune": { mutates: true, run: releasePrune },
  "cache.clean": { mutates: true, run: cacheClean },
};

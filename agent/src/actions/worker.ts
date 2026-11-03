// Processes (PLAN-PROCESSES.md): workers, a systemd service per long-running
// process of an app beside its web server, from the live release, as the app's
// user in its sandbox; and app.run, one command run once, its output streamed.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { assertInt, assertLine, assertNodeVersion, assertRelativePath, assertSlug, ValidationError } from "@layer/protocol";
import type { ActionTable, CallIO, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { ensureDir, removeManaged, writeFileAtomic } from "../fsutil.ts";
import { assertWorkerName, renderWorkerUnit, workerUnit } from "../templates/worker-unit.ts";
import { appLayout } from "./app.ts";
import { requireAppUser, runJob } from "./build.ts";

function requireApp(ctx: Context, slug: string) {
  const app = appLayout(ctx, slug);
  if (!existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  return app;
}

function requireNode(ctx: Context, version: string): string {
  const bin = join(ctx.paths.nodeRoot, version, "bin");
  if (!existsSync(join(bin, "node"))) throw new ActionError("not_found", `Node ${version} isn't installed`);
  return bin;
}

/** The live release, or null before the first deploy. */
function liveRelease(appDir: string): string | null {
  try {
    return realpathSync(join(appDir, "current"));
  } catch {
    return null;
  }
}

/** Names of the app's workers, from the unit files on disk. */
export function workerNames(ctx: Context, slug: string): string[] {
  const prefix = `app-${slug}-worker-`;
  if (!existsSync(ctx.paths.systemdDir)) return [];
  return readdirSync(ctx.paths.systemdDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".service"))
    .map((f) => f.slice(prefix.length, -".service".length))
    .sort();
}

export async function removeWorkerUnit(ctx: Context, slug: string, name: string): Promise<boolean> {
  const unit = workerUnit(slug, name);
  const file = join(ctx.paths.systemdDir, unit);
  if (!existsSync(file)) return false;
  await ctx.exec(BIN.systemctl, ["disable", "--now", unit], { allowFail: true });
  removeManaged(file);
  await ctx.exec(BIN.systemctl, ["daemon-reload"]);
  await ctx.exec(BIN.systemctl, ["reset-failed", unit], { allowFail: true });
  return true;
}

/** Writes and enables a worker; restarts it when the app has a live release, so it runs that code. */
async function workerWrite(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const name = assertWorkerName(params.name);
  const nodeVersion = assertNodeVersion(params.nodeVersion);
  const app = requireApp(ctx, slug);
  requireNode(ctx, nodeVersion);
  const unit = workerUnit(slug, name);
  const text = renderWorkerUnit({
    slug,
    name,
    nodeVersion,
    exec: params.exec as string[],
    rootDir: typeof params.rootDir === "string" && params.rootDir ? params.rootDir : undefined,
    memoryMaxMb: assertInt(params.memoryMaxMb ?? 512, "memoryMaxMb", 64, 16384),
    writablePaths: params.writablePaths as string[] | undefined,
  });
  ensureDir(ctx.paths.systemdDir, 0o755);
  writeFileAtomic(join(ctx.paths.systemdDir, unit), text, 0o644);
  await ctx.exec(BIN.systemctl, ["daemon-reload"]);
  await ctx.exec(BIN.systemctl, ["enable", unit]);
  if (!liveRelease(app.appDir)) return { slug, name, unit, started: false };
  // A worker that hit its restart limit stays failed until this.
  await ctx.exec(BIN.systemctl, ["reset-failed", unit], { allowFail: true });
  await ctx.exec(BIN.systemctl, ["restart", unit]);
  return { slug, name, unit, started: true };
}

async function workerDelete(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const name = assertWorkerName(params.name);
  if (!(await removeWorkerUnit(ctx, slug, name))) throw new ActionError("not_found", `${slug} has no worker named ${name}`);
  return { slug, name, deleted: true };
}

const CONTROLS = ["start", "stop", "restart"] as const;

async function workerControl(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const name = assertWorkerName(params.name);
  const action = params.action;
  if (typeof action !== "string" || !CONTROLS.includes(action as (typeof CONTROLS)[number])) throw new ValidationError("action", `must be one of ${CONTROLS.join(", ")}`);
  const unit = workerUnit(slug, name);
  if (!existsSync(join(ctx.paths.systemdDir, unit))) throw new ActionError("not_found", `${slug} has no worker named ${name}`);
  if (action !== "stop" && !liveRelease(appLayout(ctx, slug).appDir)) throw new ActionError("not_deployed", `${slug} isn't deployed yet: workers run from the live release`);
  if (action !== "stop") await ctx.exec(BIN.systemctl, ["reset-failed", unit], { allowFail: true });
  await ctx.exec(BIN.systemctl, [action, unit]);
  return { slug, name, action };
}

const props = (stdout: string) => Object.fromEntries(stdout.trim().split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null);

async function workerList(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  requireApp(ctx, slug);
  const workers = [];
  for (const name of workerNames(ctx, slug)) {
    const p = props(
      (
        await ctx.exec(
          BIN.systemctl,
          ["show", workerUnit(slug, name), "-pActiveState", "-pSubState", "-pResult", "-pNRestarts", "-pMemoryCurrent", "-pActiveEnterTimestamp", "-pExecMainStatus"],
          { allowFail: true },
        )
      ).stdout,
    );
    workers.push({
      name,
      state: p.ActiveState ?? "unknown",
      subState: p.SubState ?? null,
      result: p.Result ?? null,
      restarts: num(p.NRestarts) ?? 0,
      memoryBytes: num(p.MemoryCurrent),
      since: p.ActiveEnterTimestamp || null,
      exitStatus: num(p.ExecMainStatus),
    });
  }
  return { slug, workers };
}

/** argv for a one-off command: node, npm or npx on the project's Node, then plain arguments. */
function runArgv(exec: unknown, nodeBin: string): string[] {
  if (!Array.isArray(exec) || exec.length === 0 || exec.length > 64) throw new ValidationError("exec", "must be a non-empty argv array");
  const [bin, ...args] = exec;
  if (!["node", "npm", "npx"].includes(bin as string)) throw new ValidationError("exec", "argv[0] must be one of node, npm, npx");
  return [join(nodeBin, bin as string), ...args.map((a, i) => {
    const value = assertLine(a, `exec[${i + 1}]`, 1024);
    if (value === "") throw new ValidationError(`exec[${i + 1}]`, "must not be empty");
    return value;
  })];
}

export const runUnit = (slug: string) => `layer-run-${slug}.service`;

/**
 * One command, run once in the live release as the app's user, with its env
 * and sandbox (a migration, a script): its output streams back, and it's
 * stopped when the caller goes away or after timeoutSec. One at a time per app.
 */
async function appRun(params: Params, ctx: Context, io: CallIO) {
  const slug = assertSlug(params.slug);
  const nodeVersion = assertNodeVersion(params.nodeVersion);
  const rootDir = params.rootDir === undefined || params.rootDir === "" || params.rootDir === null ? null : assertRelativePath(params.rootDir, "rootDir");
  const memoryMb = assertInt(params.memoryMb ?? 1024, "memoryMb", 64, 16384);
  const timeoutSec = assertInt(params.timeoutSec ?? 3600, "timeoutSec", 10, 86_400);
  const writable = ((params.writablePaths as unknown[] | undefined) ?? []).map((p) => assertRelativePath(p, "writablePaths"));
  const { app, user } = await requireAppUser(ctx, slug);
  const nodeBin = requireNode(ctx, nodeVersion);
  const command = runArgv(params.exec, nodeBin);
  const release = liveRelease(app.appDir);
  if (!release) throw new ActionError("not_deployed", `${slug} isn't deployed yet: commands run in the live release`);
  const workdir = rootDir ? join(release, rootDir) : release;
  if (!existsSync(workdir)) throw new ActionError("not_found", `${rootDir} isn't in the live release`);
  const unit = runUnit(slug);
  const { stdout } = await ctx.exec(BIN.systemctl, ["is-active", unit], { allowFail: true });
  if (["active", "activating", "deactivating"].includes(stdout.trim())) throw new ActionError("busy", `a command is already running for ${slug}: stop it first`);

  const started = Date.now();
  // A caller that went away is only noticed on a write: an empty chunk every
  // 5 s (callers skip it) finds out, so a silent command doesn't outlive it.
  const heartbeat = setInterval(() => io.emit(""), 5000);
  const code = await runJob(ctx, io, {
    unit,
    user: user.name,
    cwd: workdir,
    readWrite: [app.data, ...writable.map((p) => join(workdir, p)).filter((p) => existsSync(p))],
    env: {
      PATH: [nodeBin, "/usr/bin", "/bin"].join(":"),
      DATA_DIR: app.data,
      NODE_ENV: "production",
      npm_config_cache: "/tmp/.npm",
      npm_config_update_notifier: "false",
      FORCE_COLOR: "1",
    },
    envFiles: [join(app.etcDir, "services.env"), app.appEnv],
    memoryMb,
    timeoutSec,
    network: true,
    command,
  }).finally(() => clearInterval(heartbeat));
  const ms = Date.now() - started;
  return { slug, code, ms, timedOut: code !== 0 && ms >= timeoutSec * 1000 - 1000 };
}

/** Stops a running command (the page's Stop button, when its stream can't be cut). */
async function appRunStop(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  await ctx.exec(BIN.systemctl, ["stop", runUnit(slug)], { allowFail: true });
  return { slug, stopped: true };
}

export const workerActions: ActionTable = {
  "worker.write": { mutates: true, run: workerWrite },
  "worker.delete": { mutates: true, run: workerDelete },
  "worker.control": { mutates: true, run: workerControl },
  "worker.list": { mutates: false, run: workerList },
  // Per app, like a build: a long command never blocks other apps' changes.
  "app.run": { mutates: true, lock: "build", run: appRun },
  // No lock: it must get through while app.run holds this app's.
  "app.run-stop": { mutates: false, run: appRunStop },
};

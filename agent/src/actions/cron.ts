// Cron jobs: a systemd timer + oneshot service per job, running as the app's
// user in its sandbox from the live release. Plain units, visible with
// `systemctl list-timers`, and they keep running without the panel.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertInt, assertNodeVersion, assertSlug } from "@layer/protocol";
import type { ActionTable, Context, Params } from "../context.ts";
import { parseCronHistory, type JournalEntry } from "../cron-history.ts";
import { ActionError } from "../errors.ts";
import { BIN } from "../exec.ts";
import { childOf, ensureDir, removeManaged, writeFileAtomic } from "../fsutil.ts";
import { assertCalendar, assertCronName, cronUnit, renderCronService, renderCronTimer } from "../templates/cron-unit.ts";
import { appLayout } from "./app.ts";

function requireApp(ctx: Context, slug: string) {
  const app = appLayout(ctx, slug);
  if (!existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  return app;
}

/** Asks systemd itself whether a calendar is valid; returns the next run time. */
async function nextElapse(ctx: Context, calendar: string): Promise<string> {
  const { code, stdout, stderr } = await ctx.exec(BIN.systemdAnalyze, ["calendar", "--iterations=1", calendar], { allowFail: true });
  if (code !== 0) throw new ActionError("invalid_schedule", `systemd doesn't accept "${calendar}": ${stderr.trim().split("\n").at(-1) ?? ""}`);
  return /Next elapse:\s*(.+)$/m.exec(stdout)?.[1]?.trim() ?? "never";
}

async function cronWrite(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const name = assertCronName(params.name);
  const calendar = assertCalendar(params.calendar);
  const nodeVersion = assertNodeVersion(params.nodeVersion);
  requireApp(ctx, slug);
  if (!existsSync(join(ctx.paths.nodeRoot, nodeVersion, "bin", "node"))) throw new ActionError("not_found", `Node ${nodeVersion} isn't installed`);
  const next = await nextElapse(ctx, calendar);
  const input = {
    slug,
    name,
    calendar,
    nodeVersion,
    exec: params.exec as string[],
    rootDir: typeof params.rootDir === "string" && params.rootDir ? params.rootDir : undefined,
    memoryMaxMb: assertInt(params.memoryMaxMb ?? 512, "memoryMaxMb", 64, 16384),
    timeoutSec: assertInt(params.timeoutSec ?? 3600, "timeoutSec", 10, 86_400),
    writablePaths: params.writablePaths as string[] | undefined,
  };
  const service = renderCronService(input);
  const timer = renderCronTimer(input);
  const unit = cronUnit(slug, name);
  ensureDir(ctx.paths.systemdDir, 0o755);
  writeFileAtomic(join(ctx.paths.systemdDir, `${unit}.service`), service, 0o644);
  writeFileAtomic(join(ctx.paths.systemdDir, `${unit}.timer`), timer, 0o644);
  await ctx.exec(BIN.systemctl, ["daemon-reload"]);
  await ctx.exec(BIN.systemctl, ["enable", "--now", `${unit}.timer`]);
  return { slug, name, unit, calendar, nextRun: next };
}

export async function removeCronUnits(ctx: Context, slug: string, name: string): Promise<boolean> {
  const unit = cronUnit(slug, name);
  const files = [`${unit}.timer`, `${unit}.service`].map((f) => join(ctx.paths.systemdDir, f));
  if (!files.some((f) => existsSync(f))) return false;
  await ctx.exec(BIN.systemctl, ["disable", "--now", `${unit}.timer`], { allowFail: true });
  await ctx.exec(BIN.systemctl, ["stop", `${unit}.service`], { allowFail: true });
  for (const f of files) removeManaged(f);
  // The timer is Persistent=, so systemd remembers its last run in a stamp
  // file that outlives the unit. Left behind, a job recreated under the same
  // name would count every slot since then as missed and run at once.
  rmSync(childOf(ctx.paths.timerStampDir, `stamp-${unit}.timer`), { force: true });
  await ctx.exec(BIN.systemctl, ["daemon-reload"]);
  await ctx.exec(BIN.systemctl, ["reset-failed", `${unit}.service`], { allowFail: true });
  return true;
}

/** Names of the app's cron jobs, from the unit files on disk. */
export function cronNames(ctx: Context, slug: string): string[] {
  const prefix = `app-${slug}-cron-`;
  if (!existsSync(ctx.paths.systemdDir)) return [];
  return readdirSync(ctx.paths.systemdDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".timer"))
    .map((f) => f.slice(prefix.length, -".timer".length))
    .sort();
}

async function cronDelete(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const name = assertCronName(params.name);
  if (!(await removeCronUnits(ctx, slug, name))) throw new ActionError("not_found", `${slug} has no cron job named ${name}`);
  return { slug, name, deleted: true };
}

async function cronRun(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const name = assertCronName(params.name);
  const unit = cronUnit(slug, name);
  if (!existsSync(join(ctx.paths.systemdDir, `${unit}.service`))) throw new ActionError("not_found", `${slug} has no cron job named ${name}`);
  // --no-block: the run shows up in cron.history; this returns at once.
  await ctx.exec(BIN.systemctl, ["start", "--no-block", `${unit}.service`]);
  return { slug, name, started: true };
}

const props = (stdout: string) => Object.fromEntries(stdout.trim().split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));

async function cronList(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  requireApp(ctx, slug);
  const jobs = [];
  for (const name of cronNames(ctx, slug)) {
    const unit = cronUnit(slug, name);
    const timerFile = readFileSync(join(ctx.paths.systemdDir, `${unit}.timer`), "utf8");
    const timer = props((await ctx.exec(BIN.systemctl, ["show", `${unit}.timer`, "-pNextElapseUSecRealtime", "-pLastTriggerUSec"], { allowFail: true })).stdout);
    const service = props(
      (await ctx.exec(BIN.systemctl, ["show", `${unit}.service`, "-pActiveState", "-pResult", "-pExecMainStatus", "-pExecMainStartTimestamp"], { allowFail: true })).stdout,
    );
    jobs.push({
      name,
      calendar: /^OnCalendar=(.+)$/m.exec(timerFile)?.[1] ?? "",
      nextRun: timer.NextElapseUSecRealtime || null,
      // The service's own start time covers both scheduled runs and "Run now"
      // (a manual start doesn't update the timer's LastTriggerUSec).
      lastRun: service.ExecMainStartTimestamp || (timer.LastTriggerUSec && timer.LastTriggerUSec !== "n/a" ? timer.LastTriggerUSec : null),
      running: service.ActiveState === "activating" || service.ActiveState === "active",
      lastResult: service.Result ?? null,
      lastExitStatus: service.ExecMainStatus !== undefined ? Number(service.ExecMainStatus) : null,
    });
  }
  return { slug, jobs };
}

async function cronHistory(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const name = assertCronName(params.name);
  const limit = assertInt(params.limit ?? 20, "limit", 1, 100);
  // The journal outlives units: a job deleted and recreated under the same name
  // (or a new app reusing a slug) would inherit old runs. `since` (unix
  // seconds, the job's creation in the panel) hides those.
  const since = params.since === undefined ? null : assertInt(params.since, "since", 0, 4_102_444_800);
  const unit = cronUnit(slug, name);
  const { stdout } = await ctx.exec(
    BIN.journalctl,
    ["--no-pager", "--output=json", "--lines=5000", `--unit=${unit}.service`, ...(since !== null ? [`--since=@${since}`] : [])],
    { allowFail: true },
  );
  const entries = stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as JournalEntry);
  return { slug, name, runs: parseCronHistory(entries, limit) };
}

export const cronActions: ActionTable = {
  "cron.write": { mutates: true, run: cronWrite },
  "cron.delete": { mutates: true, run: cronDelete },
  // No lock: starting a run never blocks on other changes.
  "cron.run": { mutates: false, run: cronRun },
  "cron.list": { mutates: false, run: cronList },
  "cron.history": { mutates: false, run: cronHistory },
};

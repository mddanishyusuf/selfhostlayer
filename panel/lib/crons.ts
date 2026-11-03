// A project's cron jobs: stored as written (cron expression + command), and
// written to the server as systemd timers through the agent. Every deploy
// rewrites them, so they always use the project's current Node version.
import { agent } from "./agent";
import { cronToCalendar } from "./cron";
import { db, now } from "./db";
import { parseStartCommand } from "./project-settings";
import type { Project } from "./projects";

export interface Cron {
  id: number;
  projectId: number;
  name: string;
  schedule: string;
  command: string;
  timeoutSec: number;
  createdAt?: number;
}

interface Row {
  id: number;
  project_id: number;
  name: string;
  schedule: string;
  command: string;
  timeout_sec: number;
  created_at: number;
}

const fromRow = (r: Row): Cron => ({ id: r.id, projectId: r.project_id, name: r.name, schedule: r.schedule, command: r.command, timeoutSec: r.timeout_sec, createdAt: r.created_at });

export const CRON_NAME = /^[a-z][a-z0-9-]{0,30}$/;

export function listCrons(projectId: number): Cron[] {
  return (db().prepare("SELECT * FROM project_crons WHERE project_id = ? ORDER BY name").all(projectId) as unknown as Row[]).map(fromRow);
}

export function getCron(projectId: number, name: string): Cron | null {
  const row = db().prepare("SELECT * FROM project_crons WHERE project_id = ? AND name = ?").get(projectId, name) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** Validates what the user typed; returns errors per field, or the cleaned values. */
export function validateCron(input: { name: string; schedule: string; command: string; timeoutSec: number }):
  | { ok: true; value: { name: string; schedule: string; calendar: string; exec: string[]; command: string; timeoutSec: number } }
  | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const name = input.name.trim();
  if (!CRON_NAME.test(name)) errors.name = "Use a-z, 0-9 and -, starting with a letter (up to 31 characters).";
  let calendar = "";
  try {
    calendar = cronToCalendar(input.schedule);
  } catch (err) {
    errors.schedule = (err as Error).message;
  }
  const exec = parseStartCommand(input.command);
  if (typeof exec === "string") errors.command = exec.replace("start command", "command");
  if (!Number.isInteger(input.timeoutSec) || input.timeoutSec < 10 || input.timeoutSec > 86_400) errors.timeoutSec = "Use 10 to 86400 seconds.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { name, schedule: input.schedule.trim().replace(/\s+/g, " "), calendar, exec: exec as string[], command: input.command.trim(), timeoutSec: input.timeoutSec } };
}

export function saveCron(projectId: number, c: { name: string; schedule: string; command: string; timeoutSec: number }): void {
  db()
    .prepare(
      `INSERT INTO project_crons (project_id, name, schedule, command, timeout_sec, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, name) DO UPDATE SET schedule = excluded.schedule, command = excluded.command, timeout_sec = excluded.timeout_sec`,
    )
    .run(projectId, c.name, c.schedule, c.command, c.timeoutSec, now());
}

export function deleteCron(projectId: number, name: string): void {
  db().prepare("DELETE FROM project_crons WHERE project_id = ? AND name = ?").run(projectId, name);
}

/** Writes one job to the server (the agent checks the schedule with systemd). */
export async function writeCron(project: Project, cron: Cron): Promise<{ nextRun: string }> {
  const v = validateCron(cron);
  if (!v.ok) throw new Error(Object.values(v.errors)[0]);
  await agent("node.install", { version: project.nodeVersion }, { server: project.serverId });
  return agent<{ nextRun: string }>("cron.write", {
    slug: project.slug,
    name: cron.name,
    calendar: v.value.calendar,
    nodeVersion: project.nodeVersion,
    exec: v.value.exec,
    rootDir: project.rootDir,
    memoryMaxMb: project.memoryMb,
    timeoutSec: cron.timeoutSec,
    writablePaths: project.runtime.kind === "node" ? project.runtime.writablePaths : [],
  });
}

/** After a deploy: rewrite every job, so they follow the project's settings. */
export async function syncCrons(project: Project): Promise<string[]> {
  const problems: string[] = [];
  for (const cron of listCrons(project.id)) {
    await writeCron(project, cron).catch((err) => problems.push(`${cron.name}: ${(err as Error).message}`));
  }
  return problems;
}

export interface LiveCron {
  name: string;
  calendar: string;
  nextRun: string | null;
  lastRun: string | null;
  running: boolean;
  lastResult: string | null;
  lastExitStatus: number | null;
}

export async function liveCrons(slug: string): Promise<Map<string, LiveCron>> {
  const res = await agent<{ jobs: LiveCron[] }>("cron.list", { slug }).catch(() => ({ jobs: [] as LiveCron[] }));
  return new Map(res.jobs.map((j) => [j.name, j]));
}

export interface CronRun {
  invocation: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "failed";
  exitStatus: number | null;
  output: string[];
}

/** Runs since the job was created here (older journal entries may belong to an earlier job with the same name). */
export async function cronHistory(slug: string, name: string, since?: number): Promise<CronRun[]> {
  const res = await agent<{ runs: CronRun[] }>("cron.history", { slug, name, limit: 30, ...(since ? { since } : {}) });
  return res.runs;
}

// A project's workers (PLAN-PROCESSES.md): long-running processes beside its
// web server, like pm2's extra apps. Stored as typed (name + command), and
// written to the server as systemd services through the agent. Every deploy
// rewrites and restarts them, so they run the live code on the project's Node.
import { agent } from "./agent";
import { db, now } from "./db";
import { liveDeployment, repoToken } from "./deploy";
import { projectFiles } from "./github-repo";
import { parseStartCommand } from "./project-settings";
import type { Project } from "./projects";

export interface Worker {
  id: number;
  projectId: number;
  name: string;
  command: string;
  memoryMb: number;
  createdAt?: number;
}

interface Row {
  id: number;
  project_id: number;
  name: string;
  command: string;
  memory_mb: number;
  created_at: number;
}

const fromRow = (r: Row): Worker => ({ id: r.id, projectId: r.project_id, name: r.name, command: r.command, memoryMb: r.memory_mb, createdAt: r.created_at });

export const WORKER_NAME = /^[a-z][a-z0-9-]{0,30}$/;
export const MAX_WORKERS = 10;

/** Workers and commands are for projects with a process of their own: GitHub projects on Node. */
export const hasProcesses = (p: Project) => p.source === "github" && p.runtime.kind === "node";

export function listWorkers(projectId: number): Worker[] {
  return (db().prepare("SELECT * FROM project_workers WHERE project_id = ? ORDER BY name").all(projectId) as unknown as Row[]).map(fromRow);
}

export function getWorker(projectId: number, name: string): Worker | null {
  const row = db().prepare("SELECT * FROM project_workers WHERE project_id = ? AND name = ?").get(projectId, name) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** Validates what the user typed; returns errors per field, or the cleaned values. */
export function validateWorker(input: { name: string; command: string; memoryMb: number }):
  | { ok: true; value: { name: string; command: string; exec: string[]; memoryMb: number } }
  | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const name = input.name.trim();
  if (!WORKER_NAME.test(name)) errors.name = "Use a-z, 0-9 and -, starting with a letter (up to 31 characters).";
  const exec = parseStartCommand(input.command);
  if (typeof exec === "string") errors.command = exec.replace("start command", "command");
  if (!Number.isInteger(input.memoryMb) || input.memoryMb < 64 || input.memoryMb > 16384) errors.memoryMb = "Use 64 to 16384 MB.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { name, command: input.command.trim().replace(/\s+/g, " "), exec: exec as string[], memoryMb: input.memoryMb } };
}

export function saveWorker(projectId: number, w: { name: string; command: string; memoryMb: number }): void {
  db()
    .prepare(
      `INSERT INTO project_workers (project_id, name, command, memory_mb, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, name) DO UPDATE SET command = excluded.command, memory_mb = excluded.memory_mb`,
    )
    .run(projectId, w.name, w.command, w.memoryMb, now());
}

export function deleteWorker(projectId: number, name: string): void {
  db().prepare("DELETE FROM project_workers WHERE project_id = ? AND name = ?").run(projectId, name);
}

/** Writes one worker to the server; the agent restarts it when the project is deployed. */
export async function writeWorker(project: Project, worker: Pick<Worker, "name" | "command" | "memoryMb">): Promise<{ started: boolean }> {
  const v = validateWorker(worker);
  if (!v.ok) throw new Error(Object.values(v.errors)[0]);
  await agent("node.install", { version: project.nodeVersion }, { server: project.serverId });
  return agent<{ started: boolean }>("worker.write", {
    slug: project.slug,
    name: v.value.name,
    nodeVersion: project.nodeVersion,
    exec: v.value.exec,
    rootDir: project.rootDir,
    memoryMaxMb: v.value.memoryMb,
    writablePaths: project.runtime.kind === "node" ? project.runtime.writablePaths : [],
  });
}

/** After a deploy: rewrite and restart every worker, so they run this release. */
export async function syncWorkers(project: Project): Promise<string[]> {
  const problems: string[] = [];
  for (const worker of listWorkers(project.id)) {
    await writeWorker(project, worker).catch((err) => problems.push(`${worker.name}: ${(err as Error).message}`));
  }
  return problems;
}

export interface LiveWorker {
  name: string;
  /** systemd's ActiveState: active, activating (restarting), inactive, failed. */
  state: string;
  subState: string | null;
  result: string | null;
  restarts: number;
  memoryBytes: number | null;
  since: string | null;
  exitStatus: number | null;
}

export async function liveWorkers(slug: string): Promise<Map<string, LiveWorker> | null> {
  const res = await agent<{ workers: LiveWorker[] }>("worker.list", { slug }).catch(() => null);
  return res ? new Map(res.workers.map((w) => [w.name, w])) : null;
}

const scriptCache = new Map<string, string[]>();

/** The live commit's package.json scripts, as `npm run <name>`: read from GitHub once per commit. */
export async function liveScripts(project: Project): Promise<string[]> {
  const sha = liveDeployment(project.id)?.sha;
  if (!sha) return [];
  const key = `${project.id}@${sha}`;
  const cached = scriptCache.get(key);
  if (cached) return cached;
  try {
    const files = await projectFiles(project.repoOwner, project.repoName, sha, project.rootDir ?? "", await repoToken(project));
    const pkg = typeof files["package.json"] === "string" ? (JSON.parse(files["package.json"]) as { scripts?: Record<string, string> }) : null;
    const scripts = scriptSuggestions(pkg?.scripts);
    scriptCache.set(key, scripts);
    return scripts;
  } catch {
    return [];
  }
}

/** package.json's scripts as `npm run <name>` suggestions for Run a command. */
export function scriptSuggestions(scripts: Record<string, string> | undefined): string[] {
  // dev and test runs belong on a laptop, not the server.
  return Object.keys(scripts ?? {})
    .filter((s) => /^[A-Za-z0-9_:.-]+$/.test(s) && !/^(dev|test|lint|format)(:|$)/.test(s))
    .slice(0, 12)
    .map((s) => `npm run ${s}`);
}

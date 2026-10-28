import type { Runtime } from "./detect";
import { decrypt, encrypt } from "./crypto";
import { db, now } from "./db";

export interface Project {
  id: number;
  slug: string;
  repoOwner: string;
  repoName: string;
  installationId: number | null;
  branch: string;
  rootDir: string;
  framework: string;
  packageManager: "npm" | "yarn" | "pnpm" | "bun";
  nodeVersion: string;
  installCommand: string | null;
  buildCommand: string | null;
  runtime: Runtime;
  domains: string[];
  memoryMb: number;
  autoDeploy: boolean;
}

interface Row {
  id: number;
  slug: string;
  repo_owner: string;
  repo_name: string;
  installation_id: number | null;
  branch: string;
  root_dir: string;
  framework: string;
  package_manager: Project["packageManager"];
  node_version: string;
  install_command: string | null;
  build_command: string | null;
  runtime: string;
  domains: string;
  memory_mb: number;
  auto_deploy: number;
}

const fromRow = (r: Row): Project => ({
  id: r.id,
  slug: r.slug,
  repoOwner: r.repo_owner,
  repoName: r.repo_name,
  installationId: r.installation_id,
  branch: r.branch,
  rootDir: r.root_dir,
  framework: r.framework,
  packageManager: r.package_manager,
  nodeVersion: r.node_version,
  installCommand: r.install_command,
  buildCommand: r.build_command,
  runtime: JSON.parse(r.runtime) as Runtime,
  domains: JSON.parse(r.domains) as string[],
  memoryMb: r.memory_mb,
  autoDeploy: r.auto_deploy === 1,
});

/** An app slug from a repo (and folder) name: lowercase, a-z0-9 and single hyphens, unique. */
export function slugFor(base: string, taken: (slug: string) => boolean): string {
  let slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[0-9-]+/, "").slice(0, 24).replace(/-+$/, "");
  if (slug.length < 2) slug = `app-${slug || "x"}`.slice(0, 24);
  if (!taken(slug)) return slug;
  for (let i = 2; i < 1000; i++) if (!taken(`${slug}-${i}`)) return `${slug}-${i}`;
  throw new Error("couldn't find a free app name");
}

export const slugTaken = (slug: string) => !!db().prepare("SELECT 1 FROM projects WHERE slug = ?").get(slug);

export type NewProject = Omit<Project, "id">;

export function createProject(p: NewProject): Project {
  const result = db()
    .prepare(
      `INSERT INTO projects (slug, repo_owner, repo_name, installation_id, branch, root_dir, framework, package_manager, node_version,
         install_command, build_command, runtime, domains, memory_mb, auto_deploy, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(p.slug, p.repoOwner, p.repoName, p.installationId, p.branch, p.rootDir, p.framework, p.packageManager, p.nodeVersion,
      p.installCommand, p.buildCommand, JSON.stringify(p.runtime), JSON.stringify(p.domains), p.memoryMb, p.autoDeploy ? 1 : 0, now());
  return getProject(Number(result.lastInsertRowid))!;
}

export function getProject(id: number): Project | null {
  const row = db().prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function getProjectBySlug(slug: string): Project | null {
  const row = db().prepare("SELECT * FROM projects WHERE slug = ?").get(slug) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function listProjects(): Project[] {
  return (db().prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as unknown as Row[]).map(fromRow);
}

/** Projects that deploy on pushes to this repo and branch. */
export function projectsForPush(owner: string, repo: string, branch: string): Project[] {
  return (
    db()
      .prepare("SELECT * FROM projects WHERE lower(repo_owner) = lower(?) AND lower(repo_name) = lower(?) AND branch = ? AND auto_deploy = 1")
      .all(owner, repo, branch) as unknown as Row[]
  ).map(fromRow);
}

export function deleteProject(id: number): void {
  db().prepare("DELETE FROM projects WHERE id = ?").run(id);
}

/** Env vars, decrypted. */
export function projectEnv(projectId: number): Record<string, string> {
  const rows = db().prepare("SELECT key, value_enc FROM project_env WHERE project_id = ? ORDER BY key").all(projectId) as { key: string; value_enc: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, decrypt(r.value_enc)]));
}

export function setProjectEnv(projectId: number, vars: Record<string, string>): void {
  const database = db();
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM project_env WHERE project_id = ?").run(projectId);
    const insert = database.prepare("INSERT INTO project_env (project_id, key, value_enc) VALUES (?, ?, ?)");
    for (const [k, v] of Object.entries(vars)) insert.run(projectId, k, encrypt(v));
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
}

export function updateProjectSettings(
  id: number,
  s: { branch: string; installCommand: string | null; buildCommand: string | null; runtime: Runtime; nodeVersion: string; memoryMb: number },
): void {
  db()
    .prepare("UPDATE projects SET branch = ?, install_command = ?, build_command = ?, runtime = ?, node_version = ?, memory_mb = ? WHERE id = ?")
    .run(s.branch, s.installCommand, s.buildCommand, JSON.stringify(s.runtime), s.nodeVersion, s.memoryMb, id);
}

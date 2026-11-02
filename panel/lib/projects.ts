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
  /** github: built from a repo; catalog: an integration, installed from the catalog (no repo, no build); site: a Sites WordPress or Ghost. */
  source: "github" | "catalog" | "site";
  /** The catalog app's id (links), for integrations; a site's engine (wordpress, ghost). */
  catalogApp: string | null;
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
  source: Project["source"];
  catalog_app: string | null;
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
  source: r.source,
  catalogApp: r.catalog_app,
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

export type NewProject = Omit<Project, "id" | "source" | "catalogApp"> & Partial<Pick<Project, "source" | "catalogApp">>;

export function createProject(p: NewProject): Project {
  const result = db()
    .prepare(
      `INSERT INTO projects (slug, repo_owner, repo_name, installation_id, branch, root_dir, framework, package_manager, node_version,
         install_command, build_command, runtime, domains, memory_mb, auto_deploy, source, catalog_app, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(p.slug, p.repoOwner, p.repoName, p.installationId, p.branch, p.rootDir, p.framework, p.packageManager, p.nodeVersion,
      p.installCommand, p.buildCommand, JSON.stringify(p.runtime), JSON.stringify(p.domains), p.memoryMb, p.autoDeploy ? 1 : 0, p.source ?? "github", p.catalogApp ?? null, now());
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

/** Every project, integrations included (the Projects page shows only source github). */
export function listProjects(): Project[] {
  return (db().prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as unknown as Row[]).map(fromRow);
}

/** The integration installed from this catalog app, if any (one per app for now). */
export function integrationFor(app: string): Project | null {
  const row = db().prepare("SELECT * FROM projects WHERE source = 'catalog' AND catalog_app = ? ORDER BY id LIMIT 1").get(app) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** Projects that deploy on pushes to this repo and branch. */
export function projectsForPush(owner: string, repo: string, branch: string): Project[] {
  return (
    db()
      .prepare("SELECT * FROM projects WHERE lower(repo_owner) = lower(?) AND lower(repo_name) = lower(?) AND branch = ? AND auto_deploy = 1")
      .all(owner, repo, branch) as unknown as Row[]
  ).map(fromRow);
}

/** The free URL is the first of a project's domains (<slug>.<appsDomain>). */
export function setFreeHost(id: number, host: string): void {
  const project = getProject(id);
  if (!project) return;
  db().prepare("UPDATE projects SET domains = ? WHERE id = ?").run(JSON.stringify([host, ...project.domains.slice(1)]), id);
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

/** What an integration's manifest decides (lib/catalog.ts applies it before each deploy). */
export interface PrivateFile {
  path: string;
  content: string;
  updatedAt: number;
}

/** Private files, decrypted, by path. */
export function projectFiles(projectId: number): PrivateFile[] {
  const rows = db().prepare("SELECT path, content_enc, updated_at FROM project_files WHERE project_id = ? ORDER BY path").all(projectId) as { path: string; content_enc: string; updated_at: number }[];
  return rows.map((r) => ({ path: r.path, content: decrypt(r.content_enc), updatedAt: r.updated_at }));
}

export function setProjectFile(projectId: number, path: string, content: string): void {
  db()
    .prepare("INSERT INTO project_files (project_id, path, content_enc, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, path) DO UPDATE SET content_enc = excluded.content_enc, updated_at = excluded.updated_at")
    .run(projectId, path, encrypt(content), now());
}

export function deleteProjectFile(projectId: number, path: string): void {
  db().prepare("DELETE FROM project_files WHERE project_id = ? AND path = ?").run(projectId, path);
}

export function updateIntegration(id: number, s: { runtime: Runtime; nodeVersion: string; memoryMb: number }): void {
  db().prepare("UPDATE projects SET runtime = ?, node_version = ?, memory_mb = ? WHERE id = ?").run(JSON.stringify(s.runtime), s.nodeVersion, s.memoryMb, id);
}

export function setMemory(id: number, memoryMb: number): void {
  db().prepare("UPDATE projects SET memory_mb = ? WHERE id = ?").run(memoryMb, id);
}

export function updateProjectSettings(
  id: number,
  s: { branch: string; installCommand: string | null; buildCommand: string | null; runtime: Runtime; nodeVersion: string; memoryMb: number },
): void {
  db()
    .prepare("UPDATE projects SET branch = ?, install_command = ?, build_command = ?, runtime = ?, node_version = ?, memory_mb = ? WHERE id = ?")
    .run(s.branch, s.installCommand, s.buildCommand, JSON.stringify(s.runtime), s.nodeVersion, s.memoryMb, id);
}

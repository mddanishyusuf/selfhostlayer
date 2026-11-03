// The deploy pipeline. One deployment runs at a time (the agent builds one at
// a time anyway); each is a sequence of agent actions:
//   fetch → install → build → (node) idle color: point, start + health check,
//   switch Caddy, drain, stop old | (static) publish + serve → prune.
// An integration (lib/catalog.ts) applies its version's manifest first, then
// fetches that version from the catalog instead of GitHub, with no build.
// Any failure leaves the live version untouched. Logs go to a file and to
// subscribers (the deployment page streams them).
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AgentError, type AppManifest } from "@layer/protocol";
import { agent, type SystemInfo } from "./agent";
import { config } from "./config";
import { db, now } from "./db";
import { installationToken } from "./github";
import { raise, resolve } from "./alerts/engine";
import { boxConfig } from "./box";
import { BuildQueue, buildMemoryFor } from "./build-queue";
import { getBackupSettings } from "./backup/settings";
import { backUpProject } from "./backup/runner";
import { applyManifest } from "./catalog";
import { checkCertificate } from "./cert";
import { syncCrons } from "./crons";
import { hasProcesses, listWorkers, syncWorkers } from "./workers";
import { servingConfig } from "./domains";
import { getApp } from "./github-store";
import { BUILD_SLOTS, readState } from "./panel-state";
import { latestCommit } from "./github-repo";
import { getProject, listProjects, projectEnv, projectFiles, type Project } from "./projects";
import { onServer } from "./servers";
import { deploySite } from "./sites";

export const BUN_VERSION = "1.3.9";
const DRAIN_MS = 2000;

export type DeployStatus = "queued" | "fetching" | "installing" | "building" | "starting" | "switching" | "ready" | "failed" | "cancelled";
export const FINISHED: DeployStatus[] = ["ready", "failed", "cancelled"];

export interface Step {
  name: "fetch" | "install" | "build" | "start" | "switch";
  ms: number | null;
}

export interface Deployment {
  id: number;
  projectId: number;
  sha: string;
  commitMessage: string;
  commitAuthor: string;
  trigger: "manual" | "push" | "rollback" | "import" | "install" | "update";
  status: DeployStatus;
  color: "blue" | "green" | "static" | "php" | null;
  error: string | null;
  steps: Step[];
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** An integration's version from the catalog, and its manifest; sha is then the release (the tarball's checksum). */
  version: string | null;
  manifest: AppManifest | null;
}

interface Row {
  id: number;
  project_id: number;
  sha: string;
  commit_message: string;
  commit_author: string;
  trigger: Deployment["trigger"];
  status: DeployStatus;
  color: Deployment["color"];
  error: string | null;
  steps: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  version: string | null;
  manifest: string | null;
}

const fromRow = (r: Row): Deployment => ({
  id: r.id,
  projectId: r.project_id,
  sha: r.sha,
  commitMessage: r.commit_message,
  commitAuthor: r.commit_author,
  trigger: r.trigger,
  status: r.status,
  color: r.color,
  error: r.error,
  steps: JSON.parse(r.steps) as Step[],
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  version: r.version,
  manifest: r.manifest ? (JSON.parse(r.manifest) as AppManifest) : null,
});

export function getDeployment(id: number): Deployment | null {
  const row = db().prepare("SELECT * FROM deployments WHERE id = ?").get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function listDeployments(projectId: number, limit = 30): Deployment[] {
  return (db().prepare("SELECT * FROM deployments WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(projectId, limit) as unknown as Row[]).map(fromRow);
}

/** Where a deployment's page is: under its project, so the project's sidebar shows. */
export const deploymentPath = (slug: string, id: number) => `/projects/${slug}/deployments/${id}`;

/** Every project's deployments, newest first, with the project's slug. */
export function listAllDeployments(limit = 50): (Deployment & { slug: string })[] {
  const rows = db().prepare("SELECT d.*, p.slug FROM deployments d JOIN projects p ON p.id = d.project_id ORDER BY d.id DESC LIMIT ?").all(limit) as unknown as (Row & { slug: string })[];
  return rows.map((r) => ({ ...fromRow(r), slug: r.slug }));
}

/** The deployment currently serving traffic: the newest ready one. */
export function liveDeployment(projectId: number): Deployment | null {
  const row = db().prepare("SELECT * FROM deployments WHERE project_id = ? AND status = 'ready' ORDER BY finished_at DESC, id DESC LIMIT 1").get(projectId) as Row | undefined;
  return row ? fromRow(row) : null;
}

function update(id: number, fields: Partial<Pick<Row, "status" | "color" | "error" | "steps" | "started_at" | "finished_at">>): void {
  const keys = Object.keys(fields);
  db().prepare(`UPDATE deployments SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => fields[k as keyof typeof fields] ?? null), id);
}

// --- logs and live updates -------------------------------------------------

// Next.js can load this module more than once (route handlers and server
// actions may get separate copies), so the event bus and the queue live on
// globalThis: the worker started by an action must reach the /events route.
interface DeployState {
  events: EventEmitter;
  builds?: BuildQueue;
  cancelRequested: Set<number>;
  recovered: boolean;
}
const g = globalThis as unknown as { layerDeploy?: DeployState };
const state: DeployState = (g.layerDeploy ??= {
  events: new EventEmitter().setMaxListeners(200),
  cancelRequested: new Set(),
  recovered: false,
});
export const events = state.events;

const logDir = () => join(dirname(config.dbPath), "logs");
export const logPath = (id: number) => join(logDir(), `deployment-${id}.log`);
export const readLog = (id: number) => (existsSync(logPath(id)) ? readFileSync(logPath(id), "utf8") : "");

function log(id: number, text: string): void {
  mkdirSync(logDir(), { recursive: true, mode: 0o700 });
  appendFileSync(logPath(id), text, { mode: 0o600 });
  events.emit(`log:${id}`, text);
}

const STEP_TITLES: Record<string, string> = {
  fetch: "Fetching source",
  install: "Installing dependencies",
  build: "Building",
  start: "Starting",
  switch: "Switching traffic",
};
const heading = (text: string) => `\n\x1b[1m▸ ${text}\x1b[0m\n`;

// --- disk space ---------------------------------------------------------------

/** Below this much free disk, builds empty the apps' package caches first. The agent refuses builds below 15%. */
const TRIM_BELOW_FREE = 0.25;

/**
 * Package caches (npm, yarn, pnpm, bun) grow without limit, one per app, and
 * filled a 19 GB server. Below 25% free disk, every app's cache over 256 MB is
 * emptied; caches refill on each app's next build, so they stay while there's
 * room and builds stay fast. Apps building right now are skipped (other than
 * this one, which hasn't started installing). Returns what was freed, for the build log.
 */
async function freeSpaceIfLow(self: number): Promise<string | null> {
  const disk = (await agent<SystemInfo>("system.info").catch(() => null))?.diskGb;
  if (!disk || disk.free / disk.total >= TRIM_BELOW_FREE) return null;
  let freedMb = 0;
  const cleaned: string[] = [];
  const building = new Set([...builds.running].map((id) => getDeployment(id)?.projectId));
  for (const project of listProjects()) {
    if (project.id !== self && building.has(project.id)) continue;
    const r = await agent<{ beforeMb: number; afterMb: number }>("cache.clean", { slug: project.slug, maxMb: 256 }).catch(() => null);
    if (r && r.beforeMb > r.afterMb) {
      freedMb += r.beforeMb - r.afterMb;
      cleaned.push(project.slug);
    }
  }
  const pct = Math.round((disk.free / disk.total) * 100);
  return cleaned.length
    ? `Only ${pct}% disk free: emptied the package caches of ${cleaned.join(", ")} (${(freedMb / 1024).toFixed(1)} GB). They refill on each app's next build.\n`
    : `Only ${pct}% disk free, and no package cache was big enough to help. Old builds and app data use the rest.\n`;
}

async function buildMemoryMb(appMb: number): Promise<number> {
  const info = await agent<SystemInfo>("system.info").catch(() => null);
  return buildMemoryFor(appMb, info?.memoryMb.total, buildSlots());
}

// --- queue -------------------------------------------------------------------

const cancelRequested = state.cancelRequested;

/** How many deployments may build at once (Settings → Builds): 1 to 4, one by default. */
export function buildSlots(): number {
  const n = Number(readState(BUILD_SLOTS));
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : 1;
}

const builds = (state.builds ??= new BuildQueue((id) => run(id), (id) => getDeployment(id)?.projectId, buildSlots));

/** How many queued deployments start before this one, or null when it isn't waiting. */
export const queuePosition = (id: number) => builds.position(id);

/** After a panel restart, unfinished deployments can't resume: fail running ones, requeue waiting ones. */
function recover(): void {
  if (state.recovered) return;
  state.recovered = true;
  db().prepare("UPDATE deployments SET status = 'failed', error = 'The panel restarted during this deployment.', finished_at = ? WHERE status NOT IN ('queued','ready','failed','cancelled')").run(now());
  for (const r of db().prepare("SELECT id FROM deployments WHERE status = 'queued' ORDER BY id").all() as { id: number }[]) builds.add(r.id);
}

/** At startup, and when Settings → Builds changes: picks up waiting deployments. */
export function resumeDeployments(): void {
  recover();
  builds.pump();
}

export function createDeployment(
  project: Project,
  trigger: Deployment["trigger"],
  commit: { sha: string; message: string; author: string },
  catalog?: { version: string; manifest: AppManifest },
  /** A site's version to install (Ghost), when there's no catalog manifest. */
  version?: string | null,
): Deployment {
  recover();
  const result = db()
    .prepare("INSERT INTO deployments (project_id, sha, commit_message, commit_author, trigger, status, version, manifest, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)")
    .run(project.id, commit.sha, commit.message, commit.author, trigger, catalog?.version ?? version ?? null, catalog ? JSON.stringify(catalog.manifest) : null, now());
  const id = Number(result.lastInsertRowid);
  builds.add(id);
  return getDeployment(id)!;
}

/** An integration's version: the live deployment's, else the newest one's. */
export function installedVersion(projectId: number): Deployment | null {
  const d = liveDeployment(projectId) ?? listDeployments(projectId, 1)[0] ?? null;
  return d?.version && d.manifest ? d : null;
}

/** Deploys the branch head (or a given commit); an integration deploys its installed version again. */
export async function deployProject(project: Project, trigger: Deployment["trigger"], sha?: string): Promise<Deployment> {
  if (project.source === "catalog") {
    const from = installedVersion(project.id);
    if (!from) throw new Error("This integration has no version to deploy.");
    return createDeployment(project, trigger, { sha: from.sha, message: from.commitMessage, author: from.commitAuthor }, { version: from.version!, manifest: from.manifest! });
  }
  if (project.source === "site") {
    // The version it runs now, put back as it should be.
    const last = listDeployments(project.id, 30).find((x) => x.version && x.status === "ready");
    return createDeployment(project, trigger, { sha: last?.sha ?? randomBytes(20).toString("hex"), message: `Redeploy ${project.catalogApp === "ghost" ? "Ghost" : "WordPress"}`, author: "" }, undefined, last?.version ?? null);
  }
  const token = await repoToken(project).catch(() => undefined);
  const commit = sha ? { sha, message: "", author: "" } : await latestCommit(project.repoOwner, project.repoName, project.branch, token);
  return createDeployment(project, trigger, commit);
}

/** Re-runs an earlier deployment's commit; instant when its build is still on the server. */
export function rollbackTo(target: Deployment): Deployment {
  const project = getProject(target.projectId);
  if (!project) throw new Error("project not found");
  const catalog = target.version && target.manifest ? { version: target.version, manifest: target.manifest } : undefined;
  return createDeployment(project, "rollback", { sha: target.sha, message: target.commitMessage, author: target.commitAuthor }, catalog);
}

/** A queued or running deployment of this project, if any. */
export function activeDeployment(projectId: number): Deployment | null {
  const row = db()
    .prepare("SELECT * FROM deployments WHERE project_id = ? AND status NOT IN ('ready','failed','cancelled') ORDER BY id DESC LIMIT 1")
    .get(projectId) as Row | undefined;
  return row ? fromRow(row) : null;
}

export async function cancelDeployment(id: number): Promise<void> {
  const d = getDeployment(id);
  if (!d || FINISHED.includes(d.status)) return;
  cancelRequested.add(id);
  if (builds.remove(id)) {
    finish(id, "cancelled", null);
    return;
  }
  const project = getProject(d.projectId);
  if (project) await agent("build.cancel", { slug: project.slug }).catch(() => {});
}

function finish(id: number, status: DeployStatus, error: string | null, color?: Deployment["color"]): void {
  update(id, { status, error, finished_at: now(), ...(color !== undefined ? { color } : {}) });
  cancelRequested.delete(id);
  events.emit(`status:${id}`, status);
  void alertOnDeploy(id, status, error).catch((err) => console.error("deploy alert failed:", err));
}

/** A failed deploy opens an incident for its project; the next successful deploy resolves it. */
async function alertOnDeploy(id: number, status: DeployStatus, error: string | null): Promise<void> {
  const d = getDeployment(id);
  const p = d ? getProject(d.projectId) : null;
  if (!d || !p) return;
  const key = `deploy:${p.id}`;
  if (status === "failed") {
    let link: string | null = null;
    try {
      link = `https://${boxConfig().panelHost}${deploymentPath(p.slug, id)}`;
    } catch {
      // no box config (dev)
    }
    await raise(key, { title: `Deploy failed: ${p.slug}`, detail: `${d.sha.slice(0, 7)}${d.commitMessage ? ` "${d.commitMessage}"` : ""}: ${error ?? "unknown error"}. The live version is unchanged.`, link, projectId: p.id });
  } else if (status === "ready") {
    await resolve(key, `Deployed ${d.sha.slice(0, 7)} successfully.`);
  }
}

/** Active domains and redirects; the free host as a fallback for projects from before domains existed. */
function serving(p: Project): { domains: string[]; redirects: { from: string; to: string }[] } {
  const config = servingConfig(p.id);
  return config.domains.length ? config : { domains: p.domains, redirects: [] };
}

/**
 * A brand-new domain's certificate is issued right after Caddy reloads; wait
 * (up to 90s) so "Ready" means visitors really get HTTPS. Not fatal: Caddy
 * keeps retrying, and the Domains page shows the status.
 */
async function waitForCertificates(id: number, hosts: string[]): Promise<void> {
  for (const host of hosts) {
    let status = await checkCertificate(host);
    if (status.ok || status.reason !== "issuing") continue;
    log(id, `Waiting for the certificate for ${host}…\n`);
    for (let i = 0; i < 30 && !status.ok && status.reason === "issuing"; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      status = await checkCertificate(host);
    }
    log(id, status.ok ? `Certificate for ${host} issued by ${status.issuer}\n` : `The certificate for ${host} isn't ready yet; Caddy keeps trying. Check DNS on the Domains page.\n`);
  }
}

/** A read-only token for exactly this repo, valid for an hour. undefined for public repos without the app. */
export async function repoToken(project: Project): Promise<string | undefined> {
  if (!project.installationId) return undefined;
  const app = getApp();
  if (!app) throw new Error("This project needs the GitHub App, which isn't connected anymore.");
  const { token } = await installationToken(app.credentials, project.installationId, {
    repositories: [project.repoName],
    permissions: { contents: "read" },
  });
  return token;
}

/** Backs the app up to the bucket before an update, when backups are set up; a failed backup stops the update. */
async function backUpBeforeUpdate(id: number, p: Project): Promise<void> {
  if (!getBackupSettings()?.keyConfirmed) {
    log(id, "Backups aren't set up (Backups in the sidebar), so there's no copy of the data from before this update.\n");
    return;
  }
  log(id, "Backing up its data before the update…\n");
  const backup = await backUpProject(p, "manual");
  if (backup.status !== "ok") throw new Error(`The backup before the update failed (${backup.error ?? "no reason given"}), so nothing was changed.`);
  log(id, `Backed up (${((backup.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB). Its Backups page can restore it.\n`);
}

/** A deployment runs on its project's server: every agent call in it, with or without a slug, goes there. */
async function run(id: number): Promise<void> {
  const d = getDeployment(id);
  const p = d ? getProject(d.projectId) : null;
  return onServer(p?.serverId ?? null, () => runHere(id));
}

async function runHere(id: number): Promise<void> {
  const d = getDeployment(id);
  if (!d || d.status !== "queued") return;
  let p = getProject(d.projectId);
  if (!p) return finish(id, "failed", "The project was deleted.");
  // An integration: fetched from the catalog (checked against its sha256), never built.
  const catalog = p.source === "catalog";

  const steps: Step[] = [];
  let stepStart = Date.now();
  const setStatus = (status: DeployStatus, step?: Step["name"]) => {
    if (step) {
      if (steps.length) steps[steps.length - 1]!.ms = Date.now() - stepStart;
      steps.push({ name: step, ms: null });
      stepStart = Date.now();
      log(id, heading(STEP_TITLES[step]!));
    }
    update(id, { status, steps: JSON.stringify(steps) });
    events.emit(`status:${id}`, status);
  };
  const stream = (action: Parameters<typeof agent>[0], params: Record<string, unknown>) =>
    agent<Record<string, unknown>>(action, params, {
      onChunk: (chunk) => {
        // Turn the agent's step markers into status changes; show the rest as is.
        const lines: string[] = [];
        for (const line of chunk.split(/(?<=\n)/)) {
          const marker = /^::layer::step (install|build)\n?$/.exec(line);
          if (marker) setStatus(marker[1] === "install" ? "installing" : "building", marker[1] as Step["name"]);
          else if (!line.startsWith("::layer::")) lines.push(line);
        }
        if (lines.length) log(id, lines.join(""));
      },
    });

  update(id, { started_at: now() });
  log(id, catalog ? `Deploying ${d.commitMessage} from the catalog (${d.trigger})\n` : p.source === "site" ? `${d.commitMessage} (${d.trigger})\n` : `Deploying ${p.repoOwner}/${p.repoName}@${d.sha.slice(0, 7)}${d.commitMessage ? ` "${d.commitMessage}"` : ""} (${d.trigger})\n`);
  try {
    // A site (WordPress, Ghost): its engine's own steps, then the same ending as any deploy.
    if (p.source === "site") {
      if (d.trigger === "update") await backUpBeforeUpdate(id, p);
      const freed = await freeSpaceIfLow(p.id);
      if (freed) log(id, freed);
      const domains = serving(p).domains;
      const done = await deploySite({ p, log: (t) => log(id, t), setStatus, stream, url: `https://${domains[0] ?? p.domains[0]}`, serving: serving(p), version: d.version });
      if (done.version || done.release) db().prepare("UPDATE deployments SET version = COALESCE(?, version), sha = COALESCE(?, sha) WHERE id = ?").run(done.version, done.release, id);
      await waitForCertificates(id, domains);
      if (steps.length) steps[steps.length - 1]!.ms = Date.now() - stepStart;
      update(id, { steps: JSON.stringify(steps) });
      log(id, `\n\x1b[32m✓ Ready\x1b[0m at ${domains.map((h) => `https://${h}`).join(", ")}\n`);
      finish(id, "ready", null, done.color);
      return;
    }
    if (catalog) {
      if (!d.version || !d.manifest) throw new Error("This deployment doesn't say which version to install.");
      // A new version may change its data (Links migrates its database at start): back it up first.
      if (d.trigger === "update") await backUpBeforeUpdate(id, p);
      // How it starts, its Node, env and cron jobs come from this version's manifest.
      for (const note of await applyManifest(p, d.manifest)) log(id, note);
      p = getProject(p.id)!;
    }
    const freed = await freeSpaceIfLow(p.id);
    if (freed) log(id, freed);
    await agent("app.create", { slug: p.slug });
    await agent("env.write", { slug: p.slug, vars: projectEnv(p.id) });
    const node = await agent<{ installed: boolean }>("node.install", { version: p.nodeVersion });
    log(id, `Node ${p.nodeVersion}${node.installed ? " (installed now)" : ""}${catalog ? "" : `, ${p.packageManager}`}\n`);
    if (!catalog && p.packageManager === "bun") await agent("tool.install", { tool: "bun", version: BUN_VERSION });

    setStatus("fetching", "fetch");
    if (catalog) {
      const fetched = await stream("catalog.fetch", { slug: p.slug, app: p.catalogApp, version: d.version, release: d.sha });
      log(id, fetched.fetched ? `Checked its sha256 and unpacked it (${Math.ceil(Number(fetched.bytes) / 1024)} KB) as app-${p.slug}\n` : "This version is already on the server.\n");
    } else {
      const token = await repoToken(p);
      const fetched = await stream("source.fetch", { slug: p.slug, owner: p.repoOwner, repo: p.repoName, sha: d.sha, ...(token ? { token } : {}) });
      // Private files go in before the build, rollbacks included, so each release has today's.
      const files = projectFiles(p.id);
      if (files.length) {
        log(id, `Writing ${files.length} private file${files.length === 1 ? "" : "s"}:\n`);
        await stream("files.place", { slug: p.slug, sha: d.sha, rootDir: p.rootDir, files: files.map(({ path, content }) => ({ path, content })) });
      }
      // A rollback whose release is still on disk skips the build.
      const builtBefore = !!db().prepare("SELECT 1 FROM deployments WHERE project_id = ? AND sha = ? AND status = 'ready' AND id != ?").get(p.id, d.sha, id);
      if (d.trigger === "rollback" && builtBefore && fetched.fetched === false) {
        log(id, "This commit's build is still on the server, so the build is skipped.\n");
      } else {
        await stream("build.run", {
          slug: p.slug,
          sha: d.sha,
          nodeVersion: p.nodeVersion,
          packageManager: p.packageManager,
          rootDir: p.rootDir,
          memoryMb: await buildMemoryMb(p.memoryMb),
          ...(p.installCommand ? { installCommand: p.installCommand } : {}),
          ...(p.buildCommand ? { buildCommand: p.buildCommand } : {}),
        });
      }
    }
    if (cancelRequested.has(id)) throw new AgentError("cancelled", "cancelled");

    let color: Deployment["color"];
    if (p.runtime.kind === "static") {
      setStatus("switching", "switch");
      await agent("static.publish", { slug: p.slug, sha: d.sha, rootDir: p.rootDir, outputDir: p.runtime.outputDir });
      await agent("proxy.set", { slug: p.slug, ...serving(p), static: true, spa: p.runtime.spa });
      color = "static";
    } else if (p.runtime.kind === "node") {
      setStatus("starting", "start");
      await agent("unit.write", {
        slug: p.slug,
        nodeVersion: p.nodeVersion,
        exec: p.runtime.exec,
        writablePaths: p.runtime.writablePaths,
        rootDir: p.rootDir,
        memoryMaxMb: p.memoryMb,
      });
      const status = await agent<{ live: "blue" | "green" | null }>("unit.status", { slug: p.slug });
      const idle = status.live === "blue" ? "green" : "blue";
      await agent("release.point", { slug: p.slug, color: idle, sha: d.sha });
      log(id, `Starting on ${idle}, waiting for ${p.runtime.healthPath} to answer…\n`);
      const started = await agent<{ readyMs: number; port: number }>("unit.start", { slug: p.slug, color: idle, healthPath: p.runtime.healthPath, timeoutSec: 120 });
      log(id, `Healthy on port ${started.port} after ${(started.readyMs / 1000).toFixed(1)}s\n`);
      setStatus("switching", "switch");
      await agent("proxy.set", { slug: p.slug, ...serving(p), color: idle });
      if (status.live) {
        // Let requests already on the old version finish.
        await new Promise((r) => setTimeout(r, DRAIN_MS));
        await agent("unit.stop", { slug: p.slug, color: status.live });
      }
      color = idle;
    } else throw new Error("This project's runtime can't be deployed this way.");
    await waitForCertificates(id, serving(p).domains);
    // Cron jobs follow the project's Node version and folder, and run from this release now.
    for (const problem of await syncCrons(p)) log(id, `Cron ${problem}\n`);
    // Workers too, restarted on this release (PLAN-PROCESSES.md).
    if (hasProcesses(p)) {
      const workers = listWorkers(p.id);
      if (workers.length) log(id, `Restarting ${workers.length === 1 ? "worker" : "workers"} ${workers.map((w) => w.name).join(", ")}…\n`);
      for (const problem of await syncWorkers(p)) log(id, `Worker ${problem}\n`);
    }
    await agent("release.prune", { slug: p.slug, keep: 5 }).catch((err) => log(id, `Pruning old releases failed: ${(err as Error).message}\n`));

    if (steps.length) steps[steps.length - 1]!.ms = Date.now() - stepStart;
    update(id, { steps: JSON.stringify(steps) });
    log(id, `\n\x1b[32m✓ Ready\x1b[0m at ${serving(p).domains.map((h) => `https://${h}`).join(", ")}\n`);
    finish(id, "ready", null, color);
  } catch (err) {
    if (steps.length) steps[steps.length - 1]!.ms = Date.now() - stepStart;
    update(id, { steps: JSON.stringify(steps) });
    const cancelled = cancelRequested.has(id) || (err instanceof AgentError && err.code === "cancelled");
    const message = err instanceof Error ? err.message : String(err);
    log(id, cancelled ? "\n\x1b[33m■ Cancelled\x1b[0m\n" : `\n\x1b[31m✗ ${message}\x1b[0m\nThe live version (if any) is unchanged.\n`);
    finish(id, cancelled ? "cancelled" : "failed", cancelled ? null : message);
  }
}

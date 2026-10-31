// Integrations: apps from the catalog (catalog.json beside the update feed,
// read through the agent), installed as projects whose code is a checked
// tarball instead of a GitHub repo. A version's manifest decides how the app
// starts, its Node, the env vars it needs and its cron jobs; everything else
// (its user and sandbox, domains, backups, logs) is a project's.
import { randomBytes } from "node:crypto";
import type { AppManifest } from "@layer/protocol";
import { agent } from "./agent";
import { boxConfig, freeHost } from "./box";
import { saveCron, validateCron } from "./crons";
import { addDomain } from "./domains";
import { nodeReleases } from "./node-releases";
import { resolveNodeVersion } from "./node-version";
import { createProject, integrationFor, projectEnv, setProjectEnv, slugFor, slugTaken, updateIntegration, type Project } from "./projects";

export interface CatalogVersion {
  version: string;
  date: string | null;
  notes: string | null;
  /** The oldest Self Host Layer that can install it. */
  minPanel: string | null;
  sha256: string;
  /** Whether this server's version can install it. */
  supported: boolean;
  manifest: AppManifest;
}

export interface CatalogApp {
  id: string;
  name: string;
  summary: string;
  /** Newest first. */
  versions: CatalogVersion[];
}

/** How long a cron job of an integration may run. */
const CRON_TIMEOUT_SEC = 3600;
const CACHE_MS = 10 * 60_000;

let cache: { at: number; apps: CatalogApp[] } | null = null;

/** The catalog, kept for 10 minutes; Install reads it again. */
export async function catalogApps({ fresh = false } = {}): Promise<CatalogApp[]> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.apps;
  const { apps } = await agent<{ apps: CatalogApp[] }>("catalog.list");
  cache = { at: Date.now(), apps };
  return apps;
}

/** A version's release on the server: the first 40 characters of its tarball's sha256 (as a commit names a GitHub release). */
export const releaseOf = (v: CatalogVersion) => v.sha256.slice(0, 40);

/**
 * The env a manifest asks for, merged into what the project has: a secret is
 * made once and kept, a setting keeps the owner's value (its default until
 * then), a fixed value always wins. The owner's other variables stay.
 */
export function manifestEnv(m: AppManifest, current: Record<string, string>, secret = () => randomBytes(32).toString("hex")): Record<string, string> {
  const env = { ...current };
  for (const [key, spec] of Object.entries(m.env)) {
    if ("generate" in spec) env[key] = env[key] || secret();
    else if ("setting" in spec) env[key] = key in env ? env[key]! : spec.default;
    else env[key] = spec.value;
  }
  return env;
}

/** The manifest's Node ("24", or an exact version) as an exact version: the server's default when it's that major, else the newest LTS of it. */
export async function nodeFor(want: string, serverDefault: string, releases = nodeReleases): Promise<string> {
  if (/^\d+\.\d+\.\d+$/.test(want)) return want;
  if (serverDefault.split(".")[0] === want) return serverDefault;
  const list = await releases().catch((err: Error) => {
    throw new Error(`Couldn't reach nodejs.org to find Node ${want} (${err.message}).`);
  });
  const version = resolveNodeVersion(want, list);
  if (!version) throw new Error(`nodejs.org lists no Node ${want} release.`);
  return version;
}

const runtimeOf = (m: AppManifest) => ({ kind: "node" as const, exec: m.runtime.start, writablePaths: m.runtime.writable, healthPath: m.runtime.health });

function saveManifestCrons(projectId: number, m: AppManifest): void {
  for (const c of m.cron) saveCron(projectId, { name: c.name, schedule: c.schedule, command: c.command, timeoutSec: CRON_TIMEOUT_SEC });
}

/**
 * Before each deploy of an integration: what its version's manifest decides.
 * How it starts, its health check and Node follow the manifest; the memory
 * limit stays the owner's, but at least the manifest's minimum; missing env
 * vars are added and fixed ones set; its cron jobs are saved as it lists them
 * (the deploy writes them to the server). Returns lines for the build log.
 */
export async function applyManifest(project: Project, m: AppManifest): Promise<string[]> {
  const notes: string[] = [];
  const nodeVersion = await nodeFor(m.runtime.node, boxConfig().defaultNode);
  const memoryMb = Math.max(project.memoryMb, m.memory.min);
  if (memoryMb !== project.memoryMb) notes.push(`Memory limit raised to ${memoryMb} MB, the least ${m.name} ${m.version} needs\n`);
  updateIntegration(project.id, { runtime: runtimeOf(m), nodeVersion, memoryMb });
  const env = projectEnv(project.id);
  const merged = manifestEnv(m, env);
  const added = Object.keys(merged).filter((k) => !(k in env));
  if (added.length) notes.push(`Added ${added.join(", ")} to the environment\n`);
  if (added.length || Object.keys(merged).some((k) => merged[k] !== env[k])) setProjectEnv(project.id, merged);
  saveManifestCrons(project.id, m);
  return notes;
}

/**
 * The project for an app from the catalog, at the newest version this server
 * can install: its free URL, env vars and cron jobs. The caller deploys it.
 */
export async function createIntegration(appId: string): Promise<{ project: Project; version: CatalogVersion }> {
  const app = (await catalogApps({ fresh: true })).find((a) => a.id === appId);
  if (!app) throw new Error("The catalog doesn't list that app.");
  if (integrationFor(app.id)) throw new Error(`${app.name} is already installed.`);
  const version = app.versions.find((v) => v.supported);
  if (!version) throw new Error(`${app.name} needs Self Host Layer ${app.versions[0]!.minPanel} or newer: update first.`);
  const m = version.manifest;
  for (const c of m.cron) {
    const check = validateCron({ name: c.name, schedule: c.schedule, command: c.command, timeoutSec: CRON_TIMEOUT_SEC });
    if (!check.ok) throw new Error(`${m.name}'s cron job ${c.name} can't be scheduled: ${Object.values(check.errors)[0]}`);
  }
  const box = boxConfig();
  const nodeVersion = await nodeFor(m.runtime.node, box.defaultNode);
  const slug = slugFor(m.id, slugTaken);
  const project = createProject({
    slug,
    repoOwner: "",
    repoName: "",
    installationId: null,
    branch: "",
    rootDir: "",
    framework: "node-server",
    packageManager: "npm",
    nodeVersion,
    installCommand: null,
    buildCommand: null,
    runtime: runtimeOf(m),
    domains: [freeHost(slug, box)],
    memoryMb: m.memory.default,
    autoDeploy: false,
    source: "catalog",
    catalogApp: m.id,
  });
  addDomain(project.id, project.domains[0]!, "free", null, "active");
  setProjectEnv(project.id, manifestEnv(m, {}));
  saveManifestCrons(project.id, m);
  return { project, version };
}

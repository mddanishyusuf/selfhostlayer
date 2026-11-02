// Databases next to an app (Redis, Postgres, MySQL, MongoDB), through the agent.
import { agent } from "./agent";
import { activeDeployment, liveDeployment, rollbackTo, type Deployment } from "./deploy";
import type { Project } from "./projects";

export interface ServiceStatus {
  slug: string;
  installed: { redis: boolean; postgres: boolean; mysql: boolean; mongodb: boolean };
  /** Whether systemd says each shared server is up. */
  running: { postgres: boolean; mysql: boolean; mongodb: boolean };
  redis?: { port: number; memoryMb: number; url: string; active: boolean; memoryUsedMb: number | null; keys?: number | null; answering: boolean };
  postgres?: SqlDatabase;
  mysql?: SqlDatabase;
  /** The same shape: a database and user on the shared server, handed over as MONGODB_URI. */
  mongodb?: SqlDatabase;
}

export interface SqlDatabase {
  database: string;
  url: string;
  sizeMb: number | null;
  /** Postgres and MySQL: how many tables. */
  tables?: number | null;
  /** MongoDB: how many collections. */
  collections?: number | null;
  answering: boolean;
}

/** The engines on this server, whether their shared servers are up, and their versions (service.status without an app). */
export interface Engines {
  installed: ServiceStatus["installed"];
  running: ServiceStatus["running"];
  versions?: { postgres: string | null; redis: string | null; mongodb: string | null };
}

/** An app gets one SQL database, Postgres or MySQL: both hand it DATABASE_URL. */
export type SqlKind = "postgres" | "mysql";
/** Every database on a shared server; MongoDB's MONGODB_URI can sit next to either SQL one. */
export type DatabaseKind = SqlKind | "mongodb";

export const serviceStatus = (slug: string) => agent<ServiceStatus>("service.status", { slug });
export const engines = () => agent<Engines>("service.status");

/**
 * A zero-downtime restart on the live build, so the app picks up new
 * services.env values (REDIS_URL, DATABASE_URL, MONGODB_URI). Null when nothing is live
 * yet (the first deploy will load them) or a deploy is already running.
 */
export function restartWithNewEnv(project: Project): Deployment | null {
  const live = liveDeployment(project.id);
  if (!live || activeDeployment(project.id) || project.runtime.kind !== "node") return null;
  return rollbackTo(live);
}

export async function addRedis(project: Project, memoryMb: number): Promise<Deployment | null> {
  const status = await serviceStatus(project.slug);
  // The first Redis on the box installs the package (about a minute).
  if (!status.installed.redis) await agent("service.install", { name: "redis" });
  await agent("redis.add", { slug: project.slug, memoryMb });
  return restartWithNewEnv(project);
}

export async function removeRedis(project: Project, keepData: boolean): Promise<Deployment | null> {
  await agent("redis.remove", { slug: project.slug, keepData });
  return restartWithNewEnv(project);
}

/** MongoDB runs once on the server, shared by every project: installing it is its own step (a minute or two). */
export async function installMongodb(): Promise<void> {
  await agent("service.install", { name: "mongodb" });
}

export async function addDatabase(project: Project, kind: DatabaseKind): Promise<Deployment | null> {
  const status = await serviceStatus(project.slug);
  if (!status.installed[kind]) {
    if (kind === "mongodb") throw new Error("MongoDB isn't installed on this server yet. Install it first, once for every project.");
    // The first SQL database of its kind installs the server (PostgreSQL or MariaDB, a minute or two).
    await agent("service.install", { name: kind });
  }
  await agent(`${kind}.add` as const, { slug: project.slug });
  return restartWithNewEnv(project);
}

export async function removeDatabase(project: Project, kind: DatabaseKind, keepData: boolean): Promise<{ archived: string | null; deployment: Deployment | null }> {
  const { archived } = await agent<{ archived: string | null }>(`${kind}.remove` as const, { slug: project.slug, keepData });
  return { archived, deployment: restartWithNewEnv(project) };
}

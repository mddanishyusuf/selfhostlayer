// Databases next to an app (Redis, Postgres, MySQL), through the agent.
import { agent } from "./agent";
import { activeDeployment, liveDeployment, rollbackTo, type Deployment } from "./deploy";
import type { Project } from "./projects";

export interface ServiceStatus {
  slug: string;
  installed: { redis: boolean; postgres: boolean; mysql: boolean };
  redis?: { port: number; memoryMb: number; url: string; active: boolean; memoryUsedMb: number | null; answering: boolean };
  postgres?: SqlDatabase;
  mysql?: SqlDatabase;
}

export interface SqlDatabase {
  database: string;
  url: string;
  sizeMb: number | null;
  answering: boolean;
}

/** An app gets one SQL database, Postgres or MySQL: both hand it DATABASE_URL. */
export type SqlKind = "postgres" | "mysql";

export const serviceStatus = (slug: string) => agent<ServiceStatus>("service.status", { slug });

/**
 * A zero-downtime restart on the live build, so the app picks up new
 * services.env values (REDIS_URL, DATABASE_URL). Null when nothing is live
 * yet (the first deploy will load them) or a deploy is already running.
 */
export function restartWithNewEnv(project: Project): Deployment | null {
  const live = liveDeployment(project.id);
  if (!live || activeDeployment(project.id) || project.runtime.kind === "static") return null;
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

export async function addSqlDatabase(project: Project, kind: SqlKind): Promise<Deployment | null> {
  const status = await serviceStatus(project.slug);
  // The first database of its kind installs the server (PostgreSQL or MariaDB, a minute or two).
  if (!status.installed[kind]) await agent("service.install", { name: kind });
  await agent(`${kind}.add` as const, { slug: project.slug });
  return restartWithNewEnv(project);
}

export async function removeSqlDatabase(project: Project, kind: SqlKind, keepData: boolean): Promise<{ archived: string | null; deployment: Deployment | null }> {
  const { archived } = await agent<{ archived: string | null }>(`${kind}.remove` as const, { slug: project.slug, keepData });
  return { archived, deployment: restartWithNewEnv(project) };
}

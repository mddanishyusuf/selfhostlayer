// Databases next to an app (Redis now, Postgres next), through the agent.
import { agent } from "./agent";
import { activeDeployment, liveDeployment, rollbackTo, type Deployment } from "./deploy";
import type { Project } from "./projects";

export interface ServiceStatus {
  slug: string;
  installed: { redis: boolean; postgres: boolean };
  redis?: { port: number; memoryMb: number; url: string; active: boolean; memoryUsedMb: number | null; answering: boolean };
  postgres?: { database: string; url: string; sizeMb: number | null; answering: boolean };
}

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

export async function addPostgres(project: Project): Promise<Deployment | null> {
  const status = await serviceStatus(project.slug);
  // The first database on the box installs PostgreSQL (a minute or two).
  if (!status.installed.postgres) await agent("service.install", { name: "postgres" });
  await agent("postgres.add", { slug: project.slug });
  return restartWithNewEnv(project);
}

export async function removePostgres(project: Project, keepData: boolean): Promise<{ archived: string | null; deployment: Deployment | null }> {
  const { archived } = await agent<{ archived: string | null }>("postgres.remove", { slug: project.slug, keepData });
  return { archived, deployment: restartWithNewEnv(project) };
}

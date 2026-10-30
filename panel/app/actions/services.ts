"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getProjectBySlug } from "@/lib/projects";
import { addDatabase, addRedis, removeDatabase, removeRedis, type DatabaseKind } from "@/lib/services";
import { requireUser } from "@/lib/session";

export interface ServiceState {
  error?: string;
  ok?: string;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** Back to the page, which says what changed and links the restart that loads the new env. */
function done(slug: string, notice: string, deploymentId: number | undefined): never {
  revalidatePath(`/projects/${slug}/databases`);
  const q = new URLSearchParams({ notice, ...(deploymentId ? { restart: String(deploymentId) } : {}) });
  redirect(`/projects/${slug}/databases?${q}`);
}

export async function addRedisAction(_prev: ServiceState, form: FormData): Promise<ServiceState> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (!project) return { error: "Project not found." };
  const memoryMb = Number(field(form, "memoryMb") || 64);
  if (!Number.isInteger(memoryMb) || memoryMb < 16 || memoryMb > 4096) return { error: "Memory must be 16–4096 MB." };
  let d;
  try {
    d = await addRedis(project, memoryMb);
  } catch (err) {
    return { error: (err as Error).message };
  }
  done(project.slug, "redis-added", d?.id);
}

export async function removeRedisAction(_prev: ServiceState, form: FormData): Promise<ServiceState> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (!project) return { error: "Project not found." };
  if (field(form, "confirm") !== project.slug) return { error: `Type ${project.slug} to confirm.` };
  let d;
  try {
    d = await removeRedis(project, form.get("deleteData") !== "on");
  } catch (err) {
    return { error: (err as Error).message };
  }
  done(project.slug, "redis-removed", d?.id);
}

async function addDb(form: FormData, kind: DatabaseKind): Promise<ServiceState> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (!project) return { error: "Project not found." };
  let d;
  try {
    d = await addDatabase(project, kind);
  } catch (err) {
    return { error: (err as Error).message };
  }
  done(project.slug, `${kind}-added`, d?.id);
}

async function removeDb(form: FormData, kind: DatabaseKind): Promise<ServiceState> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (!project) return { error: "Project not found." };
  if (field(form, "confirm") !== project.slug) return { error: `Type ${project.slug} to confirm.` };
  let result;
  try {
    result = await removeDatabase(project, kind, form.get("deleteData") !== "on");
  } catch (err) {
    return { error: (err as Error).message };
  }
  done(project.slug, result.archived ? `${kind}-removed-kept` : `${kind}-removed`, result.deployment?.id);
}

export async function addPostgresAction(_prev: ServiceState, form: FormData): Promise<ServiceState> {
  return addDb(form, "postgres");
}

export async function removePostgresAction(_prev: ServiceState, form: FormData): Promise<ServiceState> {
  return removeDb(form, "postgres");
}

export async function addMysqlAction(_prev: ServiceState, form: FormData): Promise<ServiceState> {
  return addDb(form, "mysql");
}

export async function removeMysqlAction(_prev: ServiceState, form: FormData): Promise<ServiceState> {
  return removeDb(form, "mysql");
}

export async function addMongodbAction(_prev: ServiceState, form: FormData): Promise<ServiceState> {
  return addDb(form, "mongodb");
}

export async function removeMongodbAction(_prev: ServiceState, form: FormData): Promise<ServiceState> {
  return removeDb(form, "mongodb");
}

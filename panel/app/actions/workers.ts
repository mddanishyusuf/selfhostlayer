"use server";

import { revalidatePath } from "next/cache";
import { agent } from "@/lib/agent";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";
import { deleteWorker, getWorker, hasProcesses, listWorkers, MAX_WORKERS, saveWorker, validateWorker, writeWorker } from "@/lib/workers";

export interface WorkerState {
  errors?: Record<string, string>;
  saved?: string;
  /** Whether it's running: false before the project's first deploy. */
  started?: boolean;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** Adds or updates a worker, writes its service to the server and (re)starts it. */
export async function saveWorkerAction(_prev: WorkerState, form: FormData): Promise<WorkerState> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (!project || !hasProcesses(project)) return { errors: { form: "Project not found." } };
  const v = validateWorker({ name: field(form, "name"), command: field(form, "command"), memoryMb: Number(field(form, "memoryMb") || "512") });
  if (!v.ok) return { errors: v.errors };
  if (!getWorker(project.id, v.value.name) && listWorkers(project.id).length >= MAX_WORKERS) return { errors: { form: `A project can have up to ${MAX_WORKERS} workers.` } };
  const worker = { name: v.value.name, command: v.value.command, memoryMb: v.value.memoryMb };
  let started = false;
  try {
    ({ started } = await writeWorker(project, worker));
  } catch (err) {
    return { errors: { form: err instanceof Error ? err.message : "The server refused this worker." } };
  }
  saveWorker(project.id, worker);
  revalidatePath(`/projects/${project.slug}/processes`);
  return { saved: worker.name, started };
}

/** Start, stop or restart a worker. */
export async function controlWorkerAction(form: FormData): Promise<void> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  const name = field(form, "name");
  const action = field(form, "action");
  if (!project || !getWorker(project.id, name) || !["start", "stop", "restart"].includes(action)) return;
  await agent("worker.control", { slug: project.slug, name, action }).catch(() => {});
  revalidatePath(`/projects/${project.slug}/processes`);
}

export async function deleteWorkerAction(form: FormData): Promise<void> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  const name = field(form, "name");
  if (!project) return;
  await agent("worker.delete", { slug: project.slug, name }).catch(() => {});
  deleteWorker(project.id, name);
  revalidatePath(`/projects/${project.slug}/processes`);
}

/** Stops the project's running command (Run a command's Stop button). */
export async function stopRunAction(slug: string): Promise<void> {
  await requireUser();
  const project = getProjectBySlug(slug);
  if (!project) return;
  await agent("app.run-stop", { slug: project.slug }).catch(() => {});
}

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { agent } from "@/lib/agent";
import { deleteCron, getCron, saveCron, validateCron, writeCron } from "@/lib/crons";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export interface CronState {
  errors?: Record<string, string>;
  saved?: string;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** Adds or updates a job and writes its timer to the server. */
export async function saveCronAction(_prev: CronState, form: FormData): Promise<CronState> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (!project) return { errors: { form: "Project not found." } };
  const v = validateCron({ name: field(form, "name"), schedule: field(form, "schedule"), command: field(form, "command"), timeoutSec: Number(field(form, "timeoutSec") || "3600") });
  if (!v.ok) return { errors: v.errors };
  const cron = { name: v.value.name, schedule: v.value.schedule, command: v.value.command, timeoutSec: v.value.timeoutSec };
  try {
    await writeCron(project, { id: 0, projectId: project.id, ...cron });
  } catch (err) {
    return { errors: { schedule: err instanceof Error ? err.message : "The server refused this job." } };
  }
  saveCron(project.id, cron);
  revalidatePath(`/projects/${project.slug}/crons`);
  return { saved: cron.name };
}

export async function runCronAction(form: FormData): Promise<void> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  const name = field(form, "name");
  if (!project || !getCron(project.id, name)) return;
  await agent("cron.run", { slug: project.slug, name });
  redirect(`/projects/${project.slug}/crons/${name}`);
}

export async function deleteCronAction(form: FormData): Promise<void> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  const name = field(form, "name");
  if (!project) return;
  await agent("cron.delete", { slug: project.slug, name }).catch(() => {});
  deleteCron(project.id, name);
  revalidatePath(`/projects/${project.slug}/crons`);
}

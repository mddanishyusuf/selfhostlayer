"use server";

import { redirect } from "next/navigation";
import { cancelDeployment, deployProject, getDeployment, rollbackTo } from "@/lib/deploy";
import { parseRepoUrl } from "@/lib/github-repo";
import { importRepo } from "@/lib/import";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export interface ImportState {
  error?: string;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** Import a repo (from the GitHub App list, or any public repo URL) and deploy it right away. */
export async function importAndDeploy(_prev: ImportState, form: FormData): Promise<ImportState> {
  await requireUser();
  const parsed = parseRepoUrl(field(form, "repo"));
  if (!parsed) return { error: "Enter a GitHub repository like owner/name or its URL." };
  const installationId = Number(field(form, "installationId")) || null;
  let slug: string;
  try {
    const { project } = await importRepo({ ...parsed, installationId, rootDir: field(form, "rootDir"), branch: field(form, "branch") });
    await deployProject(project, "import");
    slug = project.slug;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Import failed." };
  }
  redirect(`/projects/${slug}`);
}

export async function redeploy(form: FormData): Promise<void> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (!project) redirect("/");
  const d = await deployProject(project, "manual");
  redirect(`/deployments/${d.id}`);
}

export async function rollback(form: FormData): Promise<void> {
  await requireUser();
  const target = getDeployment(Number(field(form, "deploymentId")));
  if (!target || target.status !== "ready") redirect("/");
  const d = rollbackTo(target);
  redirect(`/deployments/${d.id}`);
}

export async function cancel(form: FormData): Promise<void> {
  await requireUser();
  const id = Number(field(form, "deploymentId"));
  await cancelDeployment(id);
  redirect(`/deployments/${id}`);
}

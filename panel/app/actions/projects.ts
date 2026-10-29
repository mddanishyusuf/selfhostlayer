"use server";

import { redirect } from "next/navigation";
import { AgentError } from "@layer/protocol";
import { agent } from "@/lib/agent";
import { activeDeployment, cancelDeployment, deploymentPath, deployProject, getDeployment, rollbackTo } from "@/lib/deploy";
import { parseRepoUrl } from "@/lib/github-repo";
import { importRepo } from "@/lib/import";
import { parseSettings } from "@/lib/project-settings";
import { deleteProject, getProject, getProjectBySlug, setProjectEnv, updateProjectSettings } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export interface ImportState {
  error?: string;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** Import a repo (from the GitHub App list, or any public repo URL), then review its settings before the first deploy. */
export async function importAndDeploy(_prev: ImportState, form: FormData): Promise<ImportState> {
  await requireUser();
  const parsed = parseRepoUrl(field(form, "repo"));
  if (!parsed) return { error: "Enter a GitHub repository like owner/name or its URL." };
  const installationId = Number(field(form, "installationId")) || null;
  let slug: string;
  try {
    const { project } = await importRepo({ ...parsed, installationId, rootDir: field(form, "rootDir"), branch: field(form, "branch") });
    slug = project.slug;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Import failed." };
  }
  redirect(`/projects/${slug}/settings?new=1`);
}

export interface SettingsState {
  errors?: Record<string, string>;
  saved?: boolean;
}

/** Saves the settings form; "deploy" in the submit button's value deploys right after. */
export async function saveSettings(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (!project) redirect("/");
  const parsed = parseSettings(form);
  if (!parsed.ok) return { errors: parsed.errors };
  const { env, ...settings } = parsed.value;
  updateProjectSettings(project.id, settings);
  setProjectEnv(project.id, env);
  if (form.get("intent") !== "deploy") return { saved: true };
  let deploymentId: number;
  try {
    deploymentId = (await deployProject({ ...project, ...settings }, activeDeployment(project.id) ? "manual" : "import")).id;
  } catch (err) {
    return { errors: { form: err instanceof Error ? err.message : "Couldn't start the deployment." } };
  }
  redirect(deploymentPath(project.slug, deploymentId));
}

/** Deletes the project and its app on the server (data/ is archived unless asked otherwise). */
export async function removeProject(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (!project) redirect("/");
  if (field(form, "confirm") !== project.slug) return { errors: { delete: `Type ${project.slug} to confirm.` } };
  if (activeDeployment(project.id)) return { errors: { delete: "A deployment is running. Wait for it or cancel it first." } };
  try {
    await agent("app.delete", { slug: project.slug, keepData: form.get("deleteData") !== "on" });
  } catch (err) {
    if (!(err instanceof AgentError && err.code === "not_found")) {
      return { errors: { delete: err instanceof Error ? err.message : "Removing the app from the server failed." } };
    }
  }
  deleteProject(project.id);
  redirect("/");
}

export async function redeploy(form: FormData): Promise<void> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (!project) redirect("/");
  const d = await deployProject(project, "manual");
  redirect(deploymentPath(project.slug, d.id));
}

export async function rollback(form: FormData): Promise<void> {
  await requireUser();
  const target = getDeployment(Number(field(form, "deploymentId")));
  if (!target || target.status !== "ready") redirect("/");
  const d = rollbackTo(target);
  const project = getProject(d.projectId);
  redirect(project ? deploymentPath(project.slug, d.id) : `/deployments/${d.id}`);
}

export async function cancel(form: FormData): Promise<void> {
  await requireUser();
  const id = Number(field(form, "deploymentId"));
  await cancelDeployment(id);
  // The old URL redirects to the deployment's place under its project.
  redirect(`/deployments/${id}`);
}

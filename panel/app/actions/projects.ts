"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AgentError, assertPrivateFiles, PRIVATE_FILES, ValidationError } from "@layer/protocol";
import { agent } from "@/lib/agent";
import { activeDeployment, cancelDeployment, deploymentPath, deployProject, getDeployment, rollbackTo, type Deployment } from "@/lib/deploy";
import { parseRepoUrl } from "@/lib/github-repo";
import { importRepo } from "@/lib/import";
import { removePreview } from "@/lib/preview";
import { parseEnvVars, parseSettings } from "@/lib/project-settings";
import { deleteProject, deleteProjectFile, getProject, getProjectBySlug, projectFiles, setProjectEnv, setProjectFile, updateProjectSettings } from "@/lib/projects";
import { restartWithNewEnv } from "@/lib/services";
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
  if (env) setProjectEnv(project.id, env);
  if (form.get("intent") !== "deploy") return { saved: true };
  let deploymentId: number;
  try {
    deploymentId = (await deployProject({ ...project, ...settings }, activeDeployment(project.id) ? "manual" : "import")).id;
  } catch (err) {
    return { errors: { form: err instanceof Error ? err.message : "Couldn't start the deployment." } };
  }
  redirect(deploymentPath(project.slug, deploymentId));
}

export interface EnvState {
  error?: string;
  saved?: string;
}

/** Saves the env vars; "apply" in the submit button's value loads them right away. */
export async function saveEnvAction(_prev: EnvState, form: FormData): Promise<EnvState> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (!project) redirect("/");
  const parsed = parseEnvVars(form.get("env"));
  if (!parsed.ok) return { error: parsed.error };
  setProjectEnv(project.id, parsed.env);
  if (form.get("intent") !== "apply") return { saved: "Saved. The next deploy uses them." };
  let d: Deployment | null;
  try {
    // A static site reads them at build time; an app gets them on a restart of its live build.
    d = project.runtime.kind === "static" ? await deployProject(project, "manual") : restartWithNewEnv(project);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't start the deployment." };
  }
  if (!d) return { saved: activeDeployment(project.id) ? "Saved. A deploy is running: redeploy after it to load them." : "Saved. The first deploy uses them." };
  redirect(deploymentPath(project.slug, d.id));
}

export interface FileState {
  error?: string;
  saved?: string;
  /** Bumped on each save, so the form clears. */
  done?: number;
}

/** After a private file changes: redeploy now (intent "apply"), or say the next deploy uses it. */
async function applyFiles(project: NonNullable<ReturnType<typeof getProjectBySlug>>, form: FormData, saved: string): Promise<FileState> {
  if (form.get("intent") !== "apply") return { saved: `${saved} The next deploy writes it.`, done: Date.now() };
  if (activeDeployment(project.id)) return { saved: `${saved} A deploy is running: redeploy after it.`, done: Date.now() };
  let d: Deployment;
  try {
    d = await deployProject(project, "manual");
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't start the deployment." };
  }
  redirect(deploymentPath(project.slug, d.id));
}

/** Adds or replaces a private file (path and content), checked like the agent checks it. */
export async function saveFileAction(_prev: FileState, form: FormData): Promise<FileState> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (!project || project.source !== "github") redirect("/");
  const path = field(form, "path").replace(/^\.?\/+/, "");
  const content = String(form.get("content") ?? "");
  if (!content) return { error: "Paste the file's contents, or choose the file." };
  const others = projectFiles(project.id).filter((f) => f.path !== path);
  try {
    assertPrivateFiles([...others, { path, content }]);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    if (err.field.endsWith(".path")) return { error: "Give a path inside the project, like serviceAccountKey.json or config/key.json: letters, digits, dots, dashes and underscores." };
    if (err.field.endsWith(".content")) return { error: `${path} is over ${PRIVATE_FILES.fileBytes / 1024} KB.` };
    return { error: `A project can have ${PRIVATE_FILES.max} private files, ${PRIVATE_FILES.totalBytes / 1024 ** 2} MB together.` };
  }
  setProjectFile(project.id, path, content);
  revalidatePath(`/projects/${project.slug}/env`);
  return applyFiles(project, form, `Saved ${path}.`);
}

export async function deleteFileAction(_prev: FileState, form: FormData): Promise<FileState> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (!project) redirect("/");
  const path = field(form, "path");
  deleteProjectFile(project.id, path);
  revalidatePath(`/projects/${project.slug}/env`);
  return { saved: `Removed ${path}. The next deploy leaves it out; the live release keeps its copy until then.`, done: Date.now() };
}

/** Deletes the project (or uninstalls an integration) and its app on the server (data/ is archived unless asked otherwise). */
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
  removePreview(project.slug);
  redirect(project.source === "catalog" ? "/integrations" : "/");
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

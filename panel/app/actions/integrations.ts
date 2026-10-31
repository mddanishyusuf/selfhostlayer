"use server";

import { redirect } from "next/navigation";
import { createIntegration, releaseOf } from "@/lib/catalog";
import { activeDeployment, createDeployment, deploymentPath, deployProject, installedVersion } from "@/lib/deploy";
import { getProjectBySlug, setMemory } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export interface InstallState {
  error?: string;
}

/** Install on the Integrations page: the project with its free URL, then its first deployment, which the page follows. */
export async function installIntegration(_prev: InstallState, form: FormData): Promise<InstallState> {
  await requireUser();
  let path: string;
  try {
    const { project, version } = await createIntegration(String(form.get("app") ?? ""));
    const m = version.manifest;
    const d = createDeployment(project, "install", { sha: releaseOf(version), message: `${m.name} ${m.version}`, author: "" }, { version: m.version, manifest: m });
    path = deploymentPath(project.slug, d.id);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't install it." };
  }
  redirect(path);
}

export interface IntegrationSettingsState {
  error?: string;
  saved?: string;
}

/** An integration's memory limit, from the manifest's minimum up; "deploy" in the submit button's value redeploys right after. */
export async function saveIntegrationSettings(_prev: IntegrationSettingsState, form: FormData): Promise<IntegrationSettingsState> {
  await requireUser();
  const project = getProjectBySlug(String(form.get("slug") ?? ""));
  if (!project || project.source !== "catalog") redirect("/integrations");
  const min = installedVersion(project.id)?.manifest?.memory.min ?? 64;
  const memoryMb = Number(form.get("memoryMb"));
  if (!Number.isInteger(memoryMb) || memoryMb < min || memoryMb > 16384) return { error: `Use ${min} to 16384 MB.` };
  setMemory(project.id, memoryMb);
  if (form.get("intent") !== "deploy") return { saved: "Saved. The next deploy uses it." };
  if (activeDeployment(project.id)) return { saved: "Saved. A deploy is running: redeploy after it to use the new limit." };
  let path: string;
  try {
    path = deploymentPath(project.slug, (await deployProject(project, "manual")).id);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't start the deployment." };
  }
  redirect(path);
}

"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { agent } from "@/lib/agent";
import { activeDeployment, createDeployment, deploymentPath, deployProject } from "@/lib/deploy";
import { applyDomains, servingConfig } from "@/lib/domains";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";
import { createSite, ENGINES, engineOf, forgetPassword, getSite, setXmlrpc, type SiteEngine } from "@/lib/sites";

export interface SiteFormState {
  error?: string;
  errors?: Record<string, string>;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** New site: the project and its row, then its install as a deployment, whose log the owner watches. */
export async function createSiteAction(_prev: SiteFormState, form: FormData): Promise<SiteFormState> {
  await requireUser();
  const engine = field(form, "engine") as SiteEngine;
  if (engine !== "wordpress" && engine !== "ghost") return { error: "Pick WordPress or Ghost." };
  const title = field(form, "title");
  const ownerName = field(form, "ownerName");
  const ownerEmail = field(form, "ownerEmail");
  const name = field(form, "name");
  const errors: Record<string, string> = {};
  if (!title || title.length > 120 || /[\r\n]/.test(title)) errors.title = "Give it a title (up to 120 characters).";
  if (!ownerName || ownerName.length > 100) errors.ownerName = "Your name, as it shows on posts.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail) || ownerEmail.length > 200) errors.ownerEmail = "An email address to sign in with.";
  if (name && !/^[a-z][a-z0-9-]{1,23}$/.test(name)) errors.name = "Lowercase letters, digits and dashes, starting with a letter.";
  if (Object.keys(errors).length) return { errors };
  let path: string;
  try {
    const project = await createSite({ engine, name, title, ownerName, ownerEmail });
    const d = createDeployment(project, "install", { sha: randomBytes(20).toString("hex"), message: `Install ${ENGINES[engine].name}`, author: "" });
    path = deploymentPath(project.slug, d.id);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't make the site." };
  }
  revalidatePath("/sites");
  redirect(path);
}

/** The owner saw their first password: forget it. */
export async function forgetPasswordAction(form: FormData): Promise<void> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (project && engineOf(project)) forgetPassword(project.id);
  revalidatePath(`/projects/${field(form, "slug")}/site`);
}

export interface SiteActionState {
  error?: string;
  saved?: string;
  /** A new password, shown once. */
  password?: string;
}

/** The engine page's buttons: updates, a new owner password, Lock code, XML-RPC. */
export async function siteAction(_prev: SiteActionState, form: FormData): Promise<SiteActionState> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  const engine = project && engineOf(project);
  if (!project || !engine) redirect("/sites");
  const op = field(form, "op");
  if (activeDeployment(project.id)) return { error: "A deploy is running: wait for it first." };
  try {
    if (op === "update" && engine === "ghost") {
      const version = field(form, "version");
      if (!/^\d+\.\d+\.\d+$/.test(version)) return { error: "No version to update to." };
      const d = createDeployment(project, "update", { sha: randomBytes(20).toString("hex"), message: `Update Ghost to ${version}`, author: "" }, undefined, version);
      redirect(deploymentPath(project.slug, d.id));
    }
    if (engine === "wordpress" && ["update-core", "update-plugins", "update-themes"].includes(op)) {
      await agent("wordpress.run", { slug: project.slug, op });
      revalidatePath(`/projects/${project.slug}/site`);
      return { saved: op === "update-core" ? "WordPress is updated." : op === "update-plugins" ? "Plugins are updated." : "Themes are updated." };
    }
    if (op === "reset-password") {
      const site = getSite(project.id)!;
      if (engine === "wordpress") {
        const user = field(form, "user") || site.ownerEmail.split("@")[0]!.replace(/[^A-Za-z0-9._-]/g, "");
        const r = await agent<{ password: string }>("wordpress.run", { slug: project.slug, op: "reset-password", user });
        return { password: r.password, saved: `A new password for ${user}.` };
      }
      return { error: "Reset Ghost's password from its sign-in page (Forgot?), once email is set up." };
    }
    if (engine === "wordpress" && (op === "lock" || op === "unlock")) {
      await agent("wordpress.config", { slug: project.slug, locked: op === "lock" });
      revalidatePath(`/projects/${project.slug}/site`);
      return { saved: op === "lock" ? "Code is locked: wp-admin can't install or update plugins, themes or WordPress." : "Code is unlocked." };
    }
    if (engine === "wordpress" && (op === "xmlrpc-on" || op === "xmlrpc-off")) {
      const on = op === "xmlrpc-on";
      await agent("wordpress.config", { slug: project.slug, xmlrpc: on });
      setXmlrpc(project.id, on);
      if (servingConfig(project.id).domains.length) await applyDomains(project);
      revalidatePath(`/projects/${project.slug}/site`);
      return { saved: on ? "XML-RPC is on (/xmlrpc.php is served)." : "XML-RPC is off." };
    }
    if (op === "redeploy") {
      const d = await deployProject(project, "manual");
      redirect(deploymentPath(project.slug, d.id));
    }
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err;
    return { error: err instanceof Error ? err.message : "That didn't work." };
  }
  return { error: "Unknown action." };
}

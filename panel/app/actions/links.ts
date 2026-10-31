"use server";

import { revalidatePath } from "next/cache";
import { boxConfig } from "@/lib/box";
import { isLinks, LinksError, linksApi, type Link } from "@/lib/links";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** The Links install the form is for. */
function install(form: FormData) {
  const project = getProjectBySlug(text(form, "slug"));
  if (!project || !isLinks(project)) throw new LinksError("That Links install doesn't exist anymore.", 404);
  return project;
}

const refresh = (slug: string) => {
  revalidatePath(`/projects/${slug}/links`);
  revalidatePath(`/projects/${slug}/stats`);
};

export interface LinkFormState {
  error?: string;
  field?: string;
  saved?: Link;
}

/** Creates a link, or saves one (id set) from the link dialog. */
export async function saveLink(_prev: LinkFormState, form: FormData): Promise<LinkFormState> {
  await requireUser();
  try {
    const project = install(form);
    const id = Number(form.get("id")) || null;
    const target = text(form, "target");
    // A short link to this panel would help nobody but someone phishing its owner.
    try {
      if (new URL(target).hostname === boxConfig().panelHost) return { error: "A short link can't point at this panel.", field: "target" };
    } catch {
      // Links says what's wrong with the URL.
    }
    const password = String(form.get("password") ?? "");
    const body: Record<string, unknown> = {
      target,
      slug: text(form, "path"),
      title: text(form, "title"),
      tags: text(form, "tags"),
      redirect: Number(form.get("redirect")) || undefined,
      passQuery: form.get("passQuery") === "on",
      expiresAt: text(form, "expiresAt") || null,
      ...(form.get("removePassword") === "on" ? { password: "" } : password ? { password } : {}),
      ...(id ? { disabled: form.get("disabled") === "on" } : {}),
    };
    const saved = id ? await linksApi<Link>(project, `links/${id}`, { method: "PATCH", body }) : await linksApi<Link>(project, "links", { method: "POST", body });
    refresh(project.slug);
    return { saved };
  } catch (err) {
    if (err instanceof LinksError) return { error: err.message, field: err.field ?? undefined };
    throw err;
  }
}

export interface QuickState {
  error?: string;
}

/** Turns a link off or back on. */
export async function setLinkDisabled(_prev: QuickState, form: FormData): Promise<QuickState> {
  await requireUser();
  try {
    const project = install(form);
    await linksApi(project, `links/${Number(form.get("id"))}`, { method: "PATCH", body: { disabled: form.get("disabled") === "true" } });
    refresh(project.slug);
    return {};
  } catch (err) {
    if (err instanceof LinksError) return { error: err.message };
    throw err;
  }
}

/** Deletes a link and its clicks, after typing its slug. */
export async function deleteLink(_prev: QuickState, form: FormData): Promise<QuickState> {
  await requireUser();
  try {
    const project = install(form);
    if (text(form, "confirm").toLowerCase() !== text(form, "path").toLowerCase()) return { error: `Type ${text(form, "path")} to confirm.` };
    await linksApi(project, `links/${Number(form.get("id"))}`, { method: "DELETE" });
    refresh(project.slug);
    return {};
  } catch (err) {
    if (err instanceof LinksError) return { error: err.message };
    throw err;
  }
}

export interface LinksSettingsState {
  error?: string;
  field?: string;
  saved?: string;
}

export async function saveLinksSettings(_prev: LinksSettingsState, form: FormData): Promise<LinksSettingsState> {
  await requireUser();
  try {
    const project = install(form);
    await linksApi(project, "settings", {
      method: "PUT",
      body: { home: text(form, "home"), missing: text(form, "missing"), defaultRedirect: Number(form.get("defaultRedirect")), keepDays: Number(form.get("keepDays")) },
    });
    revalidatePath(`/projects/${project.slug}/settings`);
    return { saved: "Saved. Links uses them right away." };
  } catch (err) {
    if (err instanceof LinksError) return { error: err.message, field: err.field ?? undefined };
    throw err;
  }
}

export interface TokenState {
  error?: string;
  /** Shown once, right after it's made. */
  token?: string;
  name?: string;
}

export async function createApiToken(_prev: TokenState, form: FormData): Promise<TokenState> {
  await requireUser();
  try {
    const project = install(form);
    const made = await linksApi<{ token: string; name: string }>(project, "tokens", { method: "POST", body: { name: text(form, "name") } });
    revalidatePath(`/projects/${project.slug}/api`);
    return { token: made.token, name: made.name };
  } catch (err) {
    if (err instanceof LinksError) return { error: err.message };
    throw err;
  }
}

export async function revokeApiToken(_prev: QuickState, form: FormData): Promise<QuickState> {
  await requireUser();
  try {
    const project = install(form);
    await linksApi(project, `tokens/${Number(form.get("id"))}`, { method: "DELETE" });
    revalidatePath(`/projects/${project.slug}/api`);
    return {};
  } catch (err) {
    if (err instanceof LinksError) return { error: err.message };
    throw err;
  }
}

export interface ImportState {
  error?: string;
  result?: { created: number; skipped: { line: number; reason: string }[] };
}

/** Links from a CSV file (Links' own export, or another shortener's). */
export async function importLinks(_prev: ImportState, form: FormData): Promise<ImportState> {
  await requireUser();
  try {
    const project = install(form);
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) return { error: "Choose a CSV file." };
    if (file.size > 5 * 1024 * 1024) return { error: "The file is over 5 MB." };
    const result = await linksApi<ImportState["result"]>(project, "import", { method: "POST", body: await file.text() });
    refresh(project.slug);
    return { result };
  } catch (err) {
    if (err instanceof LinksError) return { error: err.message };
    throw err;
  }
}

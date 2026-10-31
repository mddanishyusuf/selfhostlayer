"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { analyticsApi, AnalyticsError, analyticsInstall, type Site } from "@/lib/analytics";
import { requireUser } from "@/lib/session";

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

function install() {
  const project = analyticsInstall();
  if (!project) throw new AnalyticsError("Analytics isn't installed.", 404);
  return project;
}

export interface SiteState {
  error?: string;
}

/** Adds a site, then shows it (with the line to paste into its pages). */
export async function addSite(_prev: SiteState, form: FormData): Promise<SiteState> {
  await requireUser();
  let site: Site;
  try {
    site = await analyticsApi<Site>(install(), "sites", { method: "POST", body: { domain: text(form, "domain"), subdomains: form.get("subdomains") === "on" } });
  } catch (err) {
    if (err instanceof AnalyticsError) return { error: err.message };
    throw err;
  }
  revalidatePath("/analytics");
  redirect(`/analytics?site=${site.id}`);
}

export async function setSubdomains(_prev: SiteState, form: FormData): Promise<SiteState> {
  await requireUser();
  try {
    await analyticsApi(install(), `sites/${Number(form.get("id"))}`, { method: "PATCH", body: { subdomains: form.get("subdomains") === "true" } });
  } catch (err) {
    if (err instanceof AnalyticsError) return { error: err.message };
    throw err;
  }
  revalidatePath("/analytics");
  return {};
}

/** Deletes a site and everything counted for it, after typing its domain. */
export async function removeSite(_prev: SiteState, form: FormData): Promise<SiteState> {
  await requireUser();
  if (text(form, "confirm").toLowerCase() !== text(form, "domain")) return { error: `Type ${text(form, "domain")} to confirm.` };
  try {
    await analyticsApi(install(), `sites/${Number(form.get("id"))}`, { method: "DELETE" });
  } catch (err) {
    if (err instanceof AnalyticsError) return { error: err.message };
    throw err;
  }
  revalidatePath("/analytics");
  redirect("/analytics");
}

export interface AnalyticsSettingsState {
  error?: string;
  saved?: string;
}

export async function saveAnalyticsSettings(_prev: AnalyticsSettingsState, form: FormData): Promise<AnalyticsSettingsState> {
  await requireUser();
  try {
    await analyticsApi(install(), "settings", { method: "PUT", body: { keepDays: Number(form.get("keepDays")) } });
  } catch (err) {
    if (err instanceof AnalyticsError) return { error: err.message };
    throw err;
  }
  return { saved: "Saved. The next daily clean-up uses it." };
}

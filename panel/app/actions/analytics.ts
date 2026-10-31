"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { analyticsApi, AnalyticsError, analyticsInstall, PROVIDERS, type Site, type Source } from "@/lib/analytics";
import { requireUser } from "@/lib/session";

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

function install() {
  const project = analyticsInstall();
  if (!project) throw new AnalyticsError("Analytics isn't installed.", 404);
  return project;
}

/** Analytics' errors are the form's to show; anything else is thrown. */
async function attempt<T>(run: () => Promise<T>): Promise<{ ok: T } | { error: string; field: string | null }> {
  try {
    return { ok: await run() };
  } catch (err) {
    if (err instanceof AnalyticsError) return { error: err.message, field: err.field };
    throw err;
  }
}

const refresh = () => revalidatePath("/analytics", "layout");

export interface SiteState {
  error?: string;
}

/** Adds a site, then shows it (with the line to paste into its pages). */
export async function addSite(_prev: SiteState, form: FormData): Promise<SiteState> {
  await requireUser();
  const r = await attempt(() => analyticsApi<Site>(install(), "sites", { method: "POST", body: { domain: text(form, "domain"), subdomains: form.get("subdomains") === "on" } }));
  if ("error" in r) return { error: r.error };
  refresh();
  redirect(`/analytics/${r.ok.domain}`);
}

export async function setSubdomains(_prev: SiteState, form: FormData): Promise<SiteState> {
  await requireUser();
  const r = await attempt(() => analyticsApi(install(), `sites/${Number(form.get("id"))}`, { method: "PATCH", body: { subdomains: form.get("subdomains") === "true" } }));
  if ("error" in r) return { error: r.error };
  refresh();
  return {};
}

/** Deletes a site and everything counted for it, after typing its domain. */
export async function removeSite(_prev: SiteState, form: FormData): Promise<SiteState> {
  await requireUser();
  if (text(form, "confirm").toLowerCase() !== text(form, "domain")) return { error: `Type ${text(form, "domain")} to confirm.` };
  const r = await attempt(() => analyticsApi(install(), `sites/${Number(form.get("id"))}`, { method: "DELETE" }));
  if ("error" in r) return { error: r.error };
  refresh();
  redirect("/analytics");
}

export interface AnalyticsSettingsState {
  error?: string;
  saved?: string;
}

export async function saveAnalyticsSettings(_prev: AnalyticsSettingsState, form: FormData): Promise<AnalyticsSettingsState> {
  await requireUser();
  const r = await attempt(() => analyticsApi(install(), "settings", { method: "PUT", body: { keepDays: Number(form.get("keepDays")) } }));
  if ("error" in r) return { error: r.error };
  return { saved: "Saved. The next daily clean-up uses it." };
}

export interface GoalState {
  error?: string;
  field?: string | null;
  done?: boolean;
}

/** A new goal (no id), or changes to one. */
export async function saveGoal(_prev: GoalState, form: FormData): Promise<GoalState> {
  await requireUser();
  const id = Number(form.get("id")) || null;
  const body = { site: Number(form.get("site")), name: text(form, "name"), kind: text(form, "kind"), value: text(form, "value") };
  const r = await attempt(() => (id ? analyticsApi(install(), `goals/${id}`, { method: "PATCH", body }) : analyticsApi(install(), "goals", { method: "POST", body })));
  if ("error" in r) return { error: r.error, field: r.field };
  refresh();
  return { done: true };
}

export async function deleteGoal(_prev: GoalState, form: FormData): Promise<GoalState> {
  await requireUser();
  const r = await attempt(() => analyticsApi(install(), `goals/${Number(form.get("id"))}`, { method: "DELETE" }));
  if ("error" in r) return { error: r.error };
  refresh();
  return { done: true };
}

export interface SourceState {
  error?: string;
  field?: string | null;
  saved?: string;
}

/** Connects a payment provider with its key (checked by Analytics with one small request), then its payments sync in the background. */
export async function saveSource(_prev: SourceState, form: FormData): Promise<SourceState> {
  await requireUser();
  const provider = text(form, "provider");
  const name = PROVIDERS.find((p) => p.id === provider)?.name ?? provider;
  const r = await attempt(() =>
    analyticsApi<Source>(install(), "sources", { method: "PUT", body: { site: Number(form.get("site")), provider, key: text(form, "key"), mode: text(form, "mode") || undefined }, timeoutMs: 45_000 }),
  );
  if ("error" in r) return { error: r.error, field: r.field };
  refresh();
  return { saved: `${name} is connected. Its payments from the last 90 days are coming in.` };
}

export async function removeSource(_prev: SourceState, form: FormData): Promise<SourceState> {
  await requireUser();
  const r = await attempt(() => analyticsApi(install(), `sources?site=${Number(form.get("site"))}&provider=${encodeURIComponent(text(form, "provider"))}`, { method: "DELETE" }));
  if ("error" in r) return { error: r.error };
  refresh();
  return {};
}

export interface SyncState {
  error?: string;
  message?: string;
}

/** Pulls new payments from the site's providers now, and says what came in. */
export async function syncNow(_prev: SyncState, form: FormData): Promise<SyncState> {
  await requireUser();
  const r = await attempt(() => analyticsApi<{ results: { provider: string; added: number; error?: string }[] }>(install(), "sync", { method: "POST", body: { site: Number(form.get("site")) }, timeoutMs: 180_000 }));
  if ("error" in r) return { error: r.error };
  refresh();
  const name = (id: string) => PROVIDERS.find((p) => p.id === id)?.name ?? id;
  const failed = r.ok.results.filter((x) => x.error);
  const added = r.ok.results.reduce((n, x) => n + x.added, 0);
  if (failed.length) return { error: failed.map((x) => `${name(x.provider)}: ${x.error}`).join(" ") };
  return { message: added ? `${added} new payment${added === 1 ? "" : "s"}.` : "Nothing new." };
}

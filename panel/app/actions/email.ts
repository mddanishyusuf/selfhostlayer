"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { emailApi, EmailError, emailInstall, SHIELD_CHECKS, type Brand, type Campaign, type ImportCheck, type Step } from "@/lib/email";
import { markdownEmail } from "@/lib/markdown";
import { requireUser } from "@/lib/session";

export interface FormState {
  error?: string;
  field?: string | null;
  saved?: string;
  /** A key shown once, a test's result… */
  value?: string;
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const num = (form: FormData, name: string) => Number(form.get(name));
const ids = (form: FormData, name: string) => form.getAll(name).map(Number).filter((n) => Number.isInteger(n) && n > 0);

function install() {
  const project = emailInstall();
  if (!project) throw new EmailError("Email isn't installed.", 404);
  return project;
}

/** Runs a call; Email's errors are the form's to show, anything else is thrown. */
async function attempt<T>(run: () => Promise<T>): Promise<{ ok: T } | { error: string; field: string | null }> {
  try {
    return { ok: await run() };
  } catch (err) {
    if (err instanceof EmailError) return { error: err.message, field: err.field };
    throw err;
  }
}

const refresh = () => revalidatePath("/email", "layout");
const api = <T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}) => emailApi<T>(install(), path, init);

/** The content Email stores: HTML from Markdown (inside the brand's email) or HTML as written. */
async function content(brandId: number, format: string, source: string): Promise<{ format: "markdown" | "html"; source: string; html: string }> {
  if (format === "html") return { format: "html", source, html: source };
  const brand = await api<{ brand: Brand }>(`brands/${brandId}?days=1`);
  return { format: "markdown", source, html: source.trim() ? markdownEmail(source, { brand: brand.brand.name, address: brand.brand.address }) : "" };
}

// Brands

export async function addBrand(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api<Brand>("brands", { body: { name: text(form, "name"), fromName: text(form, "fromName") || text(form, "name"), fromEmail: text(form, "fromEmail") || undefined } }));
  if ("error" in r) return r;
  refresh();
  redirect(`/email/${r.ok.id}`);
}

export async function saveBrand(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() =>
    api(`brands/${num(form, "brand")}`, {
      method: "PATCH",
      body: { name: text(form, "name"), fromName: text(form, "fromName"), fromEmail: text(form, "fromEmail"), replyTo: text(form, "replyTo"), website: text(form, "website"), address: text(form, "address") },
    }),
  );
  if ("error" in r) return r;
  refresh();
  return { saved: "Saved." };
}

export async function saveSending(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api(`brands/${num(form, "brand")}`, { method: "PATCH", body: { rate: Number(form.get("rate")), trackOpens: form.get("trackOpens") === "on", trackClicks: form.get("trackClicks") === "on" } }));
  if ("error" in r) return r;
  refresh();
  return { saved: "Saved." };
}

export async function saveProvider(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const kind = text(form, "provider");
  const body =
    kind === "ses"
      ? { provider: "ses", region: text(form, "region"), accessKeyId: text(form, "accessKeyId"), secretAccessKey: text(form, "secretAccessKey") || undefined }
      : kind === "smtp"
        ? { provider: "smtp", host: text(form, "host"), port: Number(form.get("port")), security: text(form, "security"), username: text(form, "username"), password: text(form, "password") || undefined }
        : { provider: "none" };
  const r = await attempt(() => api(`brands/${num(form, "brand")}/provider`, { method: "PUT", body }));
  if ("error" in r) return r;
  refresh();
  return { saved: kind === "none" ? "Disconnected." : "Saved. Send a test to see it work." };
}

export async function checkProvider(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api<{ ses?: { sandbox: boolean; maxPerSecond: number; max24h: number; sent24h: number; sendingEnabled: boolean } }>(`brands/${num(form, "brand")}/provider/check`, { method: "POST", timeoutMs: 45_000 }));
  if ("error" in r) return r;
  const s = r.ok.ses;
  return { saved: s ? `Amazon SES answered: ${s.sandbox ? "still in the sandbox (only verified addresses get mail)" : "production access"}, up to ${s.maxPerSecond} a second and ${s.max24h.toLocaleString("en")} a day${s.sendingEnabled ? "" : ", sending paused by AWS"}.` : "Connected and logged in." };
}

export async function sendTestEmail(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api<{ status: string; error: string | null }>(`brands/${num(form, "brand")}/provider/test`, { body: { to: text(form, "to") }, timeoutMs: 60_000 }));
  if ("error" in r) return r;
  refresh();
  return r.ok.status === "sent" ? { saved: `Sent to ${text(form, "to")}. Check its inbox (and spam folder).` } : { error: r.ok.error ?? `It wasn't sent (${r.ok.status}).` };
}

export async function setUpSesEvents(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api(`brands/${num(form, "brand")}/ses-events`, { method: "POST", timeoutMs: 60_000 }));
  if ("error" in r) return r;
  refresh();
  return { saved: "Done: SES sends bounces, complaints and deliveries here now." };
}

export async function removeBrand(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  if (text(form, "confirm") !== text(form, "name")) return { error: `Type ${text(form, "name")} to confirm.` };
  const r = await attempt(() => api(`brands/${num(form, "brand")}`, { method: "DELETE" }));
  if ("error" in r) return r;
  refresh();
  redirect("/email");
}

// Domains

export async function addDomain(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api(`brands/${num(form, "brand")}/domains`, { body: { domain: text(form, "domain") }, timeoutMs: 45_000 }));
  if ("error" in r) return r;
  refresh();
  return { saved: "Added: create the records below, then Check." };
}

export async function verifyDomain(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api<{ status: string }>(`brands/${num(form, "brand")}/domains/${num(form, "id")}/verify`, { method: "POST", timeoutMs: 45_000 }));
  if ("error" in r) return r;
  refresh();
  return r.ok.status === "verified" ? { saved: "Verified: it can send." } : { error: "Not yet: the DKIM record isn't there as it should be. DNS can take a while to update." };
}

export async function removeDomain(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api(`brands/${num(form, "brand")}/domains/${num(form, "id")}`, { method: "DELETE", timeoutMs: 45_000 }));
  if ("error" in r) return r;
  refresh();
  return {};
}

// Lists and contacts

export async function saveList(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const id = num(form, "id");
  const body = { name: text(form, "name"), description: text(form, "description"), doubleOptIn: form.get("doubleOptIn") === "on" };
  const r = await attempt(() => (id ? api(`brands/${num(form, "brand")}/lists/${id}`, { method: "PATCH", body }) : api(`brands/${num(form, "brand")}/lists`, { body })));
  if ("error" in r) return r;
  refresh();
  return { saved: "Saved." };
}

export async function removeList(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api(`brands/${num(form, "brand")}/lists/${num(form, "id")}`, { method: "DELETE" }));
  if ("error" in r) return r;
  refresh();
  return {};
}

export async function addContact(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api(`brands/${num(form, "brand")}/contacts`, { body: { email: text(form, "email"), name: text(form, "name"), lists: ids(form, "lists"), status: "subscribed" } }));
  if ("error" in r) return r;
  refresh();
  return { saved: "Added." };
}

export async function saveContact(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const brand = num(form, "brand");
  const id = num(form, "id");
  const fields: Record<string, string> = {};
  for (const line of text(form, "fields").split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const r = await attempt(async () => {
    await api(`brands/${brand}/contacts/${id}`, { method: "PATCH", body: { email: text(form, "email"), name: text(form, "name"), status: text(form, "status"), fields } });
    // Lists: the ones ticked now, against the ones it had.
    const had = ids(form, "had");
    const want = ids(form, "lists");
    for (const l of want.filter((x) => !had.includes(x))) await api(`brands/${brand}/contacts/${id}/lists`, { body: { listId: l } });
    for (const l of had.filter((x) => !want.includes(x))) await api(`brands/${brand}/contacts/${id}/lists/${l}`, { method: "DELETE" });
  });
  if ("error" in r) return r;
  refresh();
  return { saved: "Saved." };
}

export async function removeContact(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api(`brands/${num(form, "brand")}/contacts/${num(form, "id")}`, { method: "DELETE" }));
  if ("error" in r) return r;
  refresh();
  redirect(`/email/${num(form, "brand")}/contacts`);
}

/** The CSV from a form, or an error to show. */
async function csvOf(form: FormData): Promise<string | { error: string }> {
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) return { error: "Choose a CSV file." };
  if (file.size > 50 * 1024 * 1024) return { error: "The file is over 50 MB: split it." };
  return file.text();
}

/** What Shield makes of an import's addresses, before anything is added. */
export async function checkImport(form: FormData): Promise<{ ok: ImportCheck } | { error: string }> {
  await requireUser();
  const csv = await csvOf(form);
  if (typeof csv !== "string") return csv;
  const r = await attempt(() => api<ImportCheck>(`brands/${num(form, "brand")}/import/check`, { body: { csv }, timeoutMs: 300_000 }));
  return "error" in r ? { error: r.error } : r;
}

/**
 * Imports a CSV. shield: "off" skips Shield; include: "flagged" lets refused
 * addresses in as flagged instead of leaving them out.
 */
export async function importContacts(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const csv = await csvOf(form);
  if (typeof csv !== "string") return csv;
  const body = { csv, lists: ids(form, "lists"), shield: text(form, "shield") !== "off", include: text(form, "include") === "flagged" ? "flagged" : undefined };
  const r = await attempt(() => api<{ created: number; updated: number; refused?: number; flagged?: number; skipped: { line: number; reason: string }[] }>(`brands/${num(form, "brand")}/import`, { body, timeoutMs: 300_000 }));
  if ("error" in r) return r;
  refresh();
  const { created, updated, refused = 0, flagged = 0, skipped } = r.ok;
  const other = skipped.filter((x) => !x.reason.startsWith("Shield refused"));
  const parts = [`${created.toLocaleString("en")} added`, `${updated.toLocaleString("en")} updated`];
  if (flagged) parts.push(`${flagged.toLocaleString("en")} of them flagged`);
  if (refused) parts.push(`${refused.toLocaleString("en")} refused by Shield`);
  if (other.length) parts.push(`${other.length} skipped (line ${other[0]!.line}: ${other[0]!.reason}${other.length > 1 ? ", …" : ""})`);
  return { saved: `${parts.join(", ")}.` };
}

// Shield

export async function saveShield(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const checks = Object.fromEntries(SHIELD_CHECKS.map((c) => [c.id, text(form, `check-${c.id}`) || "off"]));
  const r = await attempt(() => api(`brands/${num(form, "brand")}/shield`, { method: "PUT", body: { checks, allowDatacenter: form.get("allowDatacenter") === "on" } }));
  if ("error" in r) return r;
  refresh();
  return { saved: "Saved. New sign-ups, imports and syncs follow these from now on." };
}

export async function saveAbuseKey(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const remove = text(form, "intent") === "remove";
  const r = await attempt(() => api("shield/abuseipdb", { method: "PUT", body: { key: remove ? null : text(form, "key") } }));
  if ("error" in r) return r;
  refresh();
  return { saved: remove ? "Removed. AbuseIPDB isn't asked any more." : "Saved. Sign-ups are checked against AbuseIPDB too." };
}

export async function refreshShieldLists(_prev: FormState): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api<{ lists: { name: string; error: string | null }[] }>("shield/refresh", { method: "POST", timeoutMs: 300_000 }));
  if ("error" in r) return r;
  refresh();
  const failed = r.ok.lists.filter((l) => l.error);
  return failed.length ? { error: `${failed.map((l) => `${l.name}: ${l.error}`).join("; ")}. The last copies stay in use.` } : { saved: "Every list is up to date." };
}

export async function startCleanList(form: FormData): Promise<void> {
  await requireUser();
  await api(`brands/${num(form, "brand")}/shield/scan`, { method: "POST" });
  refresh();
}

export async function applyCleanList(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const checks = form.getAll("checks").map(String);
  if (!checks.length) return { error: "Pick at least one check." };
  const action = text(form, "action") === "unsubscribe" ? "unsubscribe" : "flag";
  const r = await attempt(() => api<{ changed: number }>(`brands/${num(form, "brand")}/shield/scan/apply`, { body: { checks, action } }));
  if ("error" in r) return r;
  refresh();
  return { saved: `${r.ok.changed.toLocaleString("en")} contact${r.ok.changed === 1 ? "" : "s"} ${action === "flag" ? "flagged: campaigns skip them until you approve them" : "unsubscribed"}.` };
}

export async function approveContact(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api(`brands/${num(form, "brand")}/contacts/${num(form, "contact")}/approve`, { method: "POST" }));
  if ("error" in r) return r;
  refresh();
  return { saved: "Approved: it gets your emails again." };
}

export async function suppress(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api(`brands/${num(form, "brand")}/suppressions`, { body: { email: text(form, "email") } }));
  if ("error" in r) return r;
  refresh();
  return { saved: "Suppressed." };
}

export async function unsuppress(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api(`brands/${num(form, "brand")}/suppressions/${encodeURIComponent(text(form, "email"))}`, { method: "DELETE" }));
  if ("error" in r) return r;
  refresh();
  return {};
}

// Campaigns

export async function newCampaign(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const brand = num(form, "brand");
  const r = await attempt(() => api<Campaign>(`brands/${brand}/campaigns`, { body: { name: text(form, "name"), lists: ids(form, "lists") } }));
  if ("error" in r) return r;
  refresh();
  redirect(`/email/${brand}/campaigns/${r.ok.id}`);
}

/** Saves the editor; then a test, or the send, when the button asked for one. */
export async function saveCampaign(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const brand = num(form, "brand");
  const id = num(form, "id");
  const intent = text(form, "intent");
  const r = await attempt(async () => {
    const c = await content(brand, text(form, "format"), String(form.get("source") ?? ""));
    await api(`brands/${brand}/campaigns/${id}`, {
      method: "PATCH",
      body: { name: text(form, "name"), subject: text(form, "subject"), preheader: text(form, "preheader"), fromName: text(form, "fromName"), fromEmail: text(form, "fromEmail"), replyTo: text(form, "replyTo"), lists: ids(form, "lists"), excludeLists: ids(form, "excludeLists"), ...c, text: "" },
    });
    if (intent === "test") return api<{ status: string; error: string | null }>(`brands/${brand}/campaigns/${id}/test`, { body: { to: text(form, "testTo") }, timeoutMs: 60_000 });
    if (intent === "send" || intent === "schedule") {
      const at = intent === "schedule" ? Date.parse(text(form, "at")) : null;
      if (intent === "schedule" && !Number.isFinite(at)) throw new EmailError("Choose when to send it.", 400, "at");
      return api(`brands/${brand}/campaigns/${id}/schedule`, { body: { at } });
    }
    return null;
  });
  if ("error" in r) return r;
  refresh();
  if (intent === "test") {
    const t = r.ok as { status: string; error: string | null };
    return t.status === "sent" ? { saved: `Saved, and a test went to ${text(form, "testTo")}.` } : { error: `Saved, but the test wasn't sent: ${t.error ?? t.status}` };
  }
  if (intent === "send" || intent === "schedule") redirect(`/email/${brand}/campaigns/${id}`);
  return { saved: "Saved." };
}

export async function campaignAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const brand = num(form, "brand");
  const id = num(form, "id");
  const action = text(form, "action");
  if (!["pause", "resume", "cancel", "unschedule", "duplicate", "delete"].includes(action)) return { error: "No such action." };
  const r = await attempt(() => (action === "delete" ? api(`brands/${brand}/campaigns/${id}`, { method: "DELETE" }) : api<Campaign>(`brands/${brand}/campaigns/${id}/${action}`, { method: "POST" })));
  if ("error" in r) return r;
  refresh();
  if (action === "delete") redirect(`/email/${brand}/campaigns`);
  if (action === "duplicate") redirect(`/email/${brand}/campaigns/${(r.ok as Campaign).id}`);
  return {};
}

// Templates

export async function saveTemplate(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const brand = num(form, "brand");
  const id = num(form, "id");
  const r = await attempt(async () => {
    const c = await content(brand, text(form, "format"), String(form.get("source") ?? ""));
    const body = { name: text(form, "name"), subject: text(form, "subject"), ...c, text: "" };
    return id ? api<{ id: number }>(`brands/${brand}/templates/${id}`, { method: "PATCH", body }) : api<{ id: number }>(`brands/${brand}/templates`, { body });
  });
  if ("error" in r) return r;
  refresh();
  if (!id) redirect(`/email/${brand}/templates/${r.ok.id}`);
  return { saved: "Saved." };
}

export async function removeTemplate(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api(`brands/${num(form, "brand")}/templates/${num(form, "id")}`, { method: "DELETE" }));
  if ("error" in r) return r;
  refresh();
  redirect(`/email/${num(form, "brand")}/templates`);
}

// Automations

export async function newAutomation(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const brand = num(form, "brand");
  const trigger = text(form, "trigger");
  const r = await attempt(() => api<{ id: number }>(`brands/${brand}/automations`, { body: { name: text(form, "name"), trigger, triggerValue: trigger === "list" ? num(form, "list") : text(form, "event"), steps: [] } }));
  if ("error" in r) return r;
  refresh();
  redirect(`/email/${brand}/automations/${r.ok.id}`);
}

/** The editor's steps come as JSON; Markdown in email steps becomes the brand's email here. */
export async function saveAutomation(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const brand = num(form, "brand");
  const id = num(form, "id");
  const r = await attempt(async () => {
    let steps: Step[];
    try {
      steps = JSON.parse(String(form.get("steps") ?? "[]")) as Step[];
    } catch {
      throw new EmailError("The steps couldn't be read.", 400);
    }
    for (const s of steps) if (s.type === "email") Object.assign(s, await content(brand, s.format, s.source || s.html), { text: "" });
    const trigger = text(form, "trigger");
    return api(`brands/${brand}/automations/${id}`, { method: "PATCH", body: { name: text(form, "name"), trigger, triggerValue: trigger === "list" ? num(form, "list") : text(form, "event"), steps } });
  });
  if ("error" in r) return r;
  refresh();
  return { saved: "Saved." };
}

export async function setAutomationStatus(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api(`brands/${num(form, "brand")}/automations/${num(form, "id")}/status`, { body: { status: text(form, "status") } }));
  if ("error" in r) return r;
  refresh();
  return {};
}

export async function removeAutomation(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api(`brands/${num(form, "brand")}/automations/${num(form, "id")}`, { method: "DELETE" }));
  if ("error" in r) return r;
  refresh();
  redirect(`/email/${num(form, "brand")}/automations`);
}

// API keys

export async function createKey(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api<{ key: string }>(`brands/${num(form, "brand")}/keys`, { body: { name: text(form, "name") } }));
  if ("error" in r) return r;
  refresh();
  return { value: r.ok.key };
}

export async function revokeKey(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api(`brands/${num(form, "brand")}/keys/${num(form, "id")}`, { method: "DELETE" }));
  if ("error" in r) return r;
  refresh();
  return {};
}

export async function saveEmailSettings(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api("settings", { method: "PUT", body: { keepBodiesDays: Number(form.get("keepBodiesDays")), keepDays: Number(form.get("keepDays")) } }));
  if ("error" in r) return r;
  return { saved: "Saved. The next daily clean-up uses it." };
}

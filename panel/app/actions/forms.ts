"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { emailApi, emailInstall, emailPublicUrl, type Brand } from "@/lib/email";
import { TEMPLATES } from "@/lib/form-templates";
import { formsApi, FormsError, formsInstall, type Form } from "@/lib/forms";
import { requireUser } from "@/lib/session";

export interface FormState {
  error?: string;
  field?: string | null;
  saved?: string;
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const num = (form: FormData, name: string) => Number(form.get(name));

function install() {
  const project = formsInstall();
  if (!project) throw new FormsError("Forms isn't installed.", 404);
  return project;
}

async function attempt<T>(run: () => Promise<T>): Promise<{ ok: T } | { error: string; field: string | null }> {
  try {
    return { ok: await run() };
  } catch (err) {
    if (err instanceof FormsError) return { error: err.message, field: err.field };
    throw err;
  }
}

const refresh = () => revalidatePath("/forms", "layout");
const api = <T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}) => formsApi<T>(install(), path, init);

export async function newForm(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const template = TEMPLATES.find((t) => t.id === text(form, "template")) ?? TEMPLATES[0]!;
  const title = text(form, "title") || (template.id === "blank" ? "Untitled form" : template.name);
  const r = await attempt(() => api<Form>("forms", { body: { title, schema: template.schema() } }));
  if ("error" in r) return r;
  refresh();
  redirect(`/forms/${r.ok.id}`);
}

/** The builder's work: the title and the schema (as JSON). */
export async function saveForm(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  let schema: unknown;
  try {
    schema = JSON.parse(String(form.get("schema") ?? "{}"));
  } catch {
    return { error: "The form couldn't be read." };
  }
  const r = await attempt(() => api(`forms/${num(form, "id")}`, { method: "PATCH", body: { title: text(form, "title"), schema } }));
  if ("error" in r) return r;
  refresh();
  return { saved: "Saved. The form's page shows it now." };
}

export async function saveFormSettings(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  // closeAt: milliseconds, worked out in the browser from its own time zone.
  const closeAt = text(form, "closeAt");
  const r = await attempt(() =>
    api(`forms/${num(form, "id")}`, {
      method: "PATCH",
      body: { slug: text(form, "slug"), status: form.get("open") === "on" ? "open" : "closed", closeAt: closeAt ? Number(closeAt) : null, maxResponses: text(form, "maxResponses") || null, closedMessage: text(form, "closedMessage") },
    }),
  );
  if ("error" in r) return r;
  refresh();
  return { saved: "Saved." };
}

export async function saveNotify(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api(`forms/${num(form, "id")}`, { method: "PATCH", body: { notify: { email: text(form, "email"), receiptField: text(form, "receiptField"), webhook: text(form, "webhook"), newSecret: form.get("newSecret") === "on" } } }));
  if ("error" in r) return r;
  refresh();
  return { saved: "Saved." };
}

export async function testWebhook(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api<{ status: number; error?: string }>(`forms/${num(form, "id")}/test-webhook`, { method: "POST", timeoutMs: 30_000 }));
  if ("error" in r) return r;
  return r.ok.error ? { error: `The test didn't go through: ${r.ok.error}.` } : { saved: `Sent: it answered ${r.ok.status}.` };
}

/** Emails go out through the Email integration: a key of the brand's, its From, and Email's address. */
export async function connectEmail(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const email = emailInstall();
  if (!email) return { error: "Install Email first: Forms sends its emails through it." };
  const brandId = num(form, "brand");
  try {
    const { brand } = await emailApi<{ brand: Brand }>(email, `brands/${brandId}?days=1`);
    if (!brand.fromEmail) return { error: `${brand.name} has no From address: set it in Email first.` };
    const { key } = await emailApi<{ key: string }>(email, `brands/${brandId}/keys`, { body: { name: "Forms" } });
    const from = brand.fromName ? `${brand.fromName} <${brand.fromEmail}>` : brand.fromEmail;
    const r = await attempt(() => api("settings", { method: "PUT", body: { email: { url: emailPublicUrl(email), key, from, brand: brand.name } } }));
    if ("error" in r) return r;
  } catch (err) {
    return { error: (err as Error).message };
  }
  refresh();
  return { saved: "Connected: notifications go out through Email." };
}

export async function disconnectEmail(_prev: FormState): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api("settings", { method: "PUT", body: { email: null } }));
  if ("error" in r) return r;
  refresh();
  return { saved: "Disconnected." };
}

export async function deleteResponse(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const id = num(form, "id");
  const r = await attempt(() => api(`forms/${id}/responses/${num(form, "response")}`, { method: "DELETE" }));
  if ("error" in r) return r;
  refresh();
  redirect(`/forms/${id}/responses`);
}

export async function deleteAllResponses(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  if (text(form, "confirm") !== "delete") return { error: "Type delete to confirm." };
  const r = await attempt(() => api(`forms/${num(form, "id")}/responses`, { method: "DELETE" }));
  if ("error" in r) return r;
  refresh();
  return { saved: "Every response was deleted." };
}

export async function duplicateForm(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  const r = await attempt(() => api<Form>(`forms/${num(form, "id")}/duplicate`, { method: "POST" }));
  if ("error" in r) return r;
  refresh();
  redirect(`/forms/${r.ok.id}`);
}

export async function deleteForm(_prev: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  if (text(form, "confirm") !== text(form, "title")) return { error: `Type ${text(form, "title")} to confirm.` };
  const r = await attempt(() => api(`forms/${num(form, "id")}`, { method: "DELETE" }));
  if ("error" in r) return r;
  refresh();
  redirect("/forms");
}

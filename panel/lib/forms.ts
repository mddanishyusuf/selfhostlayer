// Forms, the forms and surveys integration, from the panel: its admin API on
// 127.0.0.1 at the live color's port, with the token made at install
// (FORMS_ADMIN_TOKEN). Every call tells Forms where it's reachable
// (X-Public-Url), which the forms' links and embeds use.
import { redirect } from "next/navigation";
import { cache } from "react";
import { agent } from "./agent";
import { config } from "./config";
import { servingConfig } from "./domains";
import type { Schema } from "./form-schema";
import { integrationFor, projectEnv, type Project } from "./projects";

export { answerText, FIELD_LABELS, type Field, type FieldType, type Op, type Schema } from "./form-schema";

export const formsInstall = () => integrationFor("forms");

export interface Form {
  id: number;
  slug: string;
  title: string;
  schema: Schema;
  status: "open" | "closed";
  closeAt: number | null;
  maxResponses: number | null;
  closedMessage: string;
  notify: { email: string; receiptField: string; webhook: string; webhookSecret: string };
  views: number;
  starts: number;
  responses: number;
  lastResponseAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** In the list: why it takes no answers, or null. */
  closed?: string | null;
}

export interface FormResponse {
  id: number;
  formId: number;
  answers: Record<string, unknown>;
  meta: { duration: number | null; country: string | null; device: string | null; browser: string | null; referrer: string | null };
  files: { id: string; fieldId: string; name: string; type: string; size: number }[];
  createdAt: number;
}

export interface Insights {
  views: number;
  starts: number;
  responses: number;
  completion: number | null;
  medianDuration: number | null;
  series: { at: number; responses: number }[];
  fields: { id: string; label: string; type: string; answered: number; counts?: { value: string; count: number }[]; average?: number | null; nps?: number | null; latest?: string[] }[];
}

export class FormsError extends Error {
  readonly status: number;
  readonly field: string | null;
  constructor(message: string, status: number, field: string | null = null) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

/** Where Forms is reachable: a custom domain once it's live, else the free URL. */
export function formsPublicUrl(p: Project): string {
  if (config.fakeAgent && process.env.LAYER_DEV_FORMS_PUBLIC_URL) return process.env.LAYER_DEV_FORMS_PUBLIC_URL;
  const hosts = servingConfig(p.id).domains;
  return `https://${hosts.find((h) => h !== p.domains[0]) ?? hosts[0] ?? p.domains[0] ?? ""}`;
}

async function endpoint(p: Project): Promise<{ base: string; token: string }> {
  // `next dev` talks to a Forms started by hand: LAYER_DEV_FORMS_URL, with LAYER_DEV_FORMS_TOKEN.
  const devToken = config.fakeAgent ? process.env.LAYER_DEV_FORMS_TOKEN : undefined;
  const token = devToken ?? projectEnv(p.id).FORMS_ADMIN_TOKEN;
  if (!token) throw new FormsError("This Forms has no admin token: redeploy it from its Settings page.", 503);
  if (config.fakeAgent) return { base: process.env.LAYER_DEV_FORMS_URL ?? "http://127.0.0.1:4444", token };
  const status = await agent<{ live: "blue" | "green" | null; blue?: { port: number | null }; green?: { port: number | null } }>("unit.status", { slug: p.slug });
  const port = status.live ? status[status.live]?.port : null;
  if (!port) throw new FormsError("Forms isn't running. Its Deployments page shows why.", 503);
  return { base: `http://127.0.0.1:${port}`, token };
}

/** One admin API call; raw: the response itself (CSV, files). */
export async function formsApi<T>(p: Project, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const res = await formsFetch(p, path, init);
  return (await res.json()) as T;
}

export async function formsFetch(p: Project, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<Response> {
  const { base, token } = await endpoint(p);
  let res: Response;
  try {
    res = await fetch(`${base}/_admin/${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { Authorization: `Bearer ${token}`, "X-Public-Url": formsPublicUrl(p), ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
      cache: "no-store",
    });
  } catch (err) {
    throw new FormsError(`Forms didn't answer (${(err as Error).message}).`, 503);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; field?: string };
    throw new FormsError(body.error ?? `Forms answered HTTP ${res.status}`, res.status, body.field ?? null);
  }
  return res;
}

export const listForms = async (p: Project) => (await formsApi<{ forms: Form[] }>(p, "forms")).forms;
export const formsOnce = cache(listForms);

/** The Forms install and the form a page is for, or null when Forms can't be reached. */
export async function formFor(param: string): Promise<{ project: Project; form: Form; forms: Form[] } | null> {
  const project = formsInstall();
  if (!project) redirect("/forms");
  const forms = await formsOnce(project).catch(() => null);
  if (!forms) return null;
  const form = forms.find((f) => String(f.id) === param);
  if (!form) redirect("/forms");
  return { project, form, forms };
}

export interface Delivery {
  kind: "webhook" | "email" | "receipt";
  status: "pending" | "done" | "failed";
  attempts: number;
  error: string | null;
  createdAt: number;
}
/** A form whole: why it's closed, its last notifications, and the token for the builder's preview. */
export const formOf = (p: Project, id: number) => formsApi<{ form: Form; closed: string | null; deliveries: Delivery[]; preview: string }>(p, `forms/${id}`);
export const responsesOf = (p: Project, id: number, o: { q?: string; page?: number }) => {
  const q = new URLSearchParams();
  if (o.q) q.set("q", o.q);
  if (o.page && o.page > 1) q.set("page", String(o.page));
  return formsApi<{ responses: FormResponse[]; total: number; page: number; pageSize: number }>(p, `forms/${id}/responses${q.size ? `?${q}` : ""}`);
};
export const responseOf = (p: Project, id: number, rid: number) => formsApi<FormResponse>(p, `forms/${id}/responses/${rid}`);
export const insightsOf = (p: Project, id: number, days = 30) => formsApi<Insights>(p, `forms/${id}/insights?days=${days}`);
export const formsSettings = (p: Project) => formsApi<{ email: { url: string; from: string; brand: string; keyHint: string } | null }>(p, "settings");

// Email, the newsletters and transactional email integration, from the panel:
// its admin API on 127.0.0.1 at the live color's port, with the token made at
// install (EMAIL_ADMIN_TOKEN, kept encrypted with the project's env). Every
// call tells Email where it's reachable (X-Public-Url: its custom domain once
// live, else its free URL), which the links in its emails use.
import { redirect } from "next/navigation";
import { cache } from "react";
import { agent } from "./agent";
import { config } from "./config";
import { servingConfig } from "./domains";
import { integrationFor, projectEnv, type Project } from "./projects";
import { requireUser } from "./session";

export const emailInstall = () => integrationFor("email");

export type ProviderKind = "none" | "smtp" | "ses";

export interface Brand {
  id: number;
  name: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  address: string;
  website: string;
  provider: ProviderKind;
  smtp: { host: string; port: number; security: "tls" | "starttls" | "none"; username: string; hasPassword: boolean } | null;
  ses: { region: string; accessKeyId: string; hasSecret: boolean; events: { configurationSet: string; topicArn: string } | null } | null;
  rate: number;
  trackOpens: boolean;
  trackClicks: boolean;
  createdAt: number;
  /** In the brand list: subscribed contacts, and emails sent in 30 days. */
  contacts?: number;
  sent30d?: number;
}

export interface DnsRecord {
  purpose: "DKIM" | "SPF" | "DMARC";
  type: "TXT" | "CNAME";
  name: string;
  value: string;
  required: boolean;
  ok: boolean | null;
  found: string | null;
}

export interface Domain {
  id: number;
  brandId: number;
  domain: string;
  status: "pending" | "verified" | "failed";
  records: DnsRecord[];
  checkedAt: number | null;
  verifiedAt: number | null;
  createdAt: number;
}

export type ContactStatus = "subscribed" | "unconfirmed" | "unsubscribed" | "bounced" | "complained";

export interface Contact {
  id: number;
  brandId: number;
  email: string;
  name: string;
  fields: Record<string, string>;
  status: ContactStatus;
  source: string;
  lists: number[];
  createdAt: number;
  updatedAt: number;
  unsubscribedAt: number | null;
}

export interface List {
  id: number;
  brandId: number;
  name: string;
  description: string;
  publicKey: string;
  doubleOptIn: boolean;
  subscribed: number;
  total: number;
  createdAt: number;
}

export interface CampaignStats {
  recipients: number;
  queued: number;
  sent: number;
  delivered: number;
  failed: number;
  bounced: number;
  complained: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
}

export type CampaignStatus = "draft" | "scheduled" | "sending" | "paused" | "sent" | "cancelled";

export interface Campaign {
  id: number;
  brandId: number;
  name: string;
  subject: string;
  preheader: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  html: string;
  text: string;
  source: string;
  format: "markdown" | "html";
  lists: number[];
  excludeLists: number[];
  status: CampaignStatus;
  pausedReason: string | null;
  scheduledAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
  stats: CampaignStats;
}

export interface Template {
  id: number;
  brandId: number;
  name: string;
  subject: string;
  html: string;
  text: string;
  source: string;
  format: "markdown" | "html";
  createdAt: number;
  updatedAt: number;
}

export type Step =
  | { type: "wait"; minutes: number }
  | { type: "email"; subject: string; preheader: string; html: string; text: string; source: string; format: "markdown" | "html"; fromName: string; fromEmail: string }
  | { type: "add_to_list"; listId: number }
  | { type: "remove_from_list"; listId: number };

export interface Automation {
  id: number;
  brandId: number;
  name: string;
  trigger: "list" | "event";
  triggerValue: string;
  steps: Step[];
  status: "draft" | "active" | "paused";
  createdAt: number;
  updatedAt: number;
  runs: { active: number; done: number; exited: number; failed: number };
}

export interface Run {
  id: number;
  contactId: number;
  email: string;
  step: number;
  status: "active" | "done" | "exited" | "failed";
  nextAt: number;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface KeyInfo {
  id: number;
  brandId: number;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface MessageRow {
  id: string;
  kind: "campaign" | "transactional" | "automation" | "test" | "confirm";
  to: string;
  from: string;
  subject: string;
  status: string;
  error: string | null;
  createdAt: number;
  sendAt: number;
  sentAt: number | null;
  openedAt: number | null;
  clickedAt: number | null;
  opens: number;
  clicks: number;
}

export interface Stats {
  days: number;
  from: number;
  series: { at: number; sent: number; opened: number; clicked: number; bounced: number; complained: number; unsubscribed: number; failed: number }[];
  total: { sent: number; opened: number; clicked: number; bounced: number; complained: number; unsubscribed: number; failed: number };
}

export interface Overview {
  brand: Brand;
  contacts: Record<ContactStatus | "total", number>;
  stats: Stats;
  domains: Domain[];
  campaigns: Campaign[];
}

export class EmailError extends Error {
  readonly status: number;
  readonly field: string | null;
  constructor(message: string, status: number, field: string | null = null) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

/** Where Email is reachable: a custom domain once it's live, else the free URL. */
export function emailPublicUrl(p: Project): string {
  if (config.fakeAgent && process.env.LAYER_DEV_EMAIL_PUBLIC_URL) return process.env.LAYER_DEV_EMAIL_PUBLIC_URL;
  const hosts = servingConfig(p.id).domains;
  const host = hosts.find((h) => h !== p.domains[0]) ?? hosts[0] ?? p.domains[0] ?? "";
  return `https://${host}`;
}

async function endpoint(p: Project): Promise<{ base: string; token: string }> {
  // `next dev` talks to an Email started by hand: LAYER_DEV_EMAIL_URL, with LAYER_DEV_EMAIL_TOKEN.
  const devToken = config.fakeAgent ? process.env.LAYER_DEV_EMAIL_TOKEN : undefined;
  const token = devToken ?? projectEnv(p.id).EMAIL_ADMIN_TOKEN;
  if (!token) throw new EmailError("This Email has no admin token: redeploy it from its Settings page.", 503);
  if (config.fakeAgent) return { base: process.env.LAYER_DEV_EMAIL_URL ?? "http://127.0.0.1:4333", token };
  const status = await agent<{ live: "blue" | "green" | null; blue?: { port: number | null }; green?: { port: number | null } }>("unit.status", { slug: p.slug });
  const port = status.live ? status[status.live]?.port : null;
  if (!port) throw new EmailError("Email isn't running. Its Deployments page shows why.", 503);
  return { base: `http://127.0.0.1:${port}`, token };
}

/** One admin API call; Email's own errors come back as EmailError. raw: the response's text (CSV). */
export async function emailApi<T>(p: Project, path: string, init: { method?: string; body?: unknown; timeoutMs?: number; raw?: boolean } = {}): Promise<T> {
  const { base, token } = await endpoint(p);
  let res: Response;
  try {
    res = await fetch(`${base}/_admin/${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { Authorization: `Bearer ${token}`, "X-Public-Url": emailPublicUrl(p), ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
      cache: "no-store",
    });
  } catch (err) {
    throw new EmailError(`Email didn't answer (${(err as Error).message}).`, 503);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; field?: string };
    throw new EmailError(body.error ?? `Email answered HTTP ${res.status}`, res.status, body.field ?? null);
  }
  return (init.raw ? await res.text() : await res.json()) as T;
}

export const listBrands = async (p: Project) => (await emailApi<{ brands: Brand[] }>(p, "brands")).brands;

/** The brands, once per request: Email's sidebar and the page both need them. */
export const brandsOnce = cache(listBrands);

/**
 * The Email install and the brand a page is for (its id in the URL), or null
 * when Email can't be reached (the layout says why). Anything else goes back
 * to /email.
 */
export async function brandFor(param: string): Promise<{ project: Project; brand: Brand; brands: Brand[] } | null> {
  await requireUser();
  const project = emailInstall();
  if (!project) redirect("/email");
  const brands = await brandsOnce(project).catch(() => null);
  if (!brands) return null;
  const brand = brands.find((b) => String(b.id) === param);
  if (!brand) redirect("/email");
  return { project, brand, brands };
}

const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const overviewOf = (p: Project, brand: number, days = 30) => emailApi<Overview>(p, `brands/${brand}${qs({ days })}`);
export const domainsOf = async (p: Project, brand: number) => (await emailApi<{ domains: Domain[] }>(p, `brands/${brand}/domains`)).domains;
export const listsOf = async (p: Project, brand: number) => (await emailApi<{ lists: List[] }>(p, `brands/${brand}/lists`)).lists;
export const contactsOf = (p: Project, brand: number, o: { q?: string; list?: string; status?: string; page?: number }) =>
  emailApi<{ contacts: Contact[]; total: number; page: number; pageSize: number }>(p, `brands/${brand}/contacts${qs({ q: o.q, list: o.list, status: o.status, page: o.page && o.page > 1 ? o.page : undefined })}`);
export const contactOf = (p: Project, brand: number, id: number) =>
  emailApi<{ contact: Contact; suppressed: boolean; messages: { id: string; kind: string; subject: string; status: string; createdAt: number; sentAt: number | null; openedAt: number | null; clickedAt: number | null; campaignId: number | null; campaign: string | null }[] }>(p, `brands/${brand}/contacts/${id}`);
export const suppressionsOf = (p: Project, brand: number, page = 1) => emailApi<{ items: { email: string; reason: string; detail: string; createdAt: number }[]; total: number }>(p, `brands/${brand}/suppressions${qs({ page: page > 1 ? page : undefined })}`);
export const campaignsOf = async (p: Project, brand: number) => (await emailApi<{ campaigns: Campaign[] }>(p, `brands/${brand}/campaigns`)).campaigns;
export const campaignOf = (p: Project, brand: number, id: number) => emailApi<{ campaign: Campaign; links: { url: string; clicks: number; people: number }[]; audience: number; problems: string[] }>(p, `brands/${brand}/campaigns/${id}`);
export const templatesOf = async (p: Project, brand: number) => (await emailApi<{ templates: Template[] }>(p, `brands/${brand}/templates`)).templates;
export const templateOf = (p: Project, brand: number, id: number) => emailApi<Template>(p, `brands/${brand}/templates/${id}`);
export const automationsOf = async (p: Project, brand: number) => (await emailApi<{ automations: Automation[] }>(p, `brands/${brand}/automations`)).automations;
export const automationOf = (p: Project, brand: number, id: number, page = 1) => emailApi<{ automation: Automation; runs: Run[]; total: number }>(p, `brands/${brand}/automations/${id}${qs({ page: page > 1 ? page : undefined })}`);
export const keysOf = async (p: Project, brand: number) => (await emailApi<{ keys: KeyInfo[] }>(p, `brands/${brand}/keys`)).keys;
export const messagesOf = (p: Project, brand: number, o: { kind?: string; status?: string; q?: string; page?: number }) =>
  emailApi<{ messages: MessageRow[]; total: number; page: number; pageSize: number }>(p, `brands/${brand}/messages${qs({ kind: o.kind, status: o.status, q: o.q, page: o.page && o.page > 1 ? o.page : undefined })}`);
export const messageOf = (p: Project, brand: number, id: string) =>
  emailApi<{ message: Record<string, unknown> & { id: string; kind: string; to_email: string; from_email: string; subject: string; status: string; error: string | null; created_at: number; sent_at: number | null; opens: number; clicks: number }; payload: { from: string; to: string[]; cc?: string[]; bcc?: string[]; replyTo?: string[]; subject: string; html?: string; text?: string; attachments?: { filename: string; contentType: string; bytes: number }[] } | null; events: { at: number; kind: string; detail: string | null }[] }>(
    p,
    `brands/${brand}/messages/${encodeURIComponent(id)}`,
  );

/** What a brand still needs before it can send, in order. */
export function setupSteps(o: { brand: Brand; domains: Domain[]; lists?: number }): { label: string; done: boolean; href: string }[] {
  const b = o.brand;
  const verified = o.domains.filter((d) => d.status === "verified").map((d) => d.domain);
  const fromOk = !!b.fromEmail && verified.includes(b.fromEmail.split("@")[1]!.toLowerCase());
  return [
    { label: "Connect SMTP or Amazon SES", done: b.provider !== "none", href: `/email/${b.id}/settings#provider` },
    { label: "Verify a sending domain", done: verified.length > 0, href: `/email/${b.id}/domains` },
    { label: "Send from an address on it", done: fromOk, href: `/email/${b.id}/settings` },
    ...(o.lists !== undefined ? [{ label: "Add a list and contacts", done: o.lists > 0, href: `/email/${b.id}/lists` }] : []),
  ];
}

// Links, the link shortener integration, from the panel: its admin API on
// 127.0.0.1 at the live color's port, with the token made at install
// (LINKS_ADMIN_TOKEN, kept encrypted with the project's env). The API never
// answers through Caddy, so only this server can manage the links.
import { agent } from "./agent";
import { config } from "./config";
import { servingConfig } from "./domains";
import { projectEnv, type Project } from "./projects";

export const isLinks = (p: Project) => p.source === "catalog" && p.catalogApp === "links";

export type Redirect = 301 | 302 | 307 | 308;

export interface Link {
  id: number;
  slug: string;
  target: string;
  title: string;
  tags: string[];
  redirect: Redirect;
  passQuery: boolean;
  hasPassword: boolean;
  expiresAt: number | null;
  disabled: boolean;
  clicks: number;
  createdAt: number;
  updatedAt: number;
}

export interface LinkList {
  links: Link[];
  total: number;
  tags: { tag: string; links: number }[];
}

export type Range = "24h" | "7d" | "30d";
export interface Count {
  name: string;
  clicks: number;
}
export interface LinkStats {
  range: Range;
  from: number;
  to: number;
  bucket: "hour" | "day";
  total: { clicks: number; visitors: number; bots: number };
  series: { at: number; clicks: number; visitors: number }[];
  links: { id: number; slug: string; clicks: number }[];
  referrers: Count[];
  countries: Count[];
  devices: Count[];
  browsers: Count[];
  os: Count[];
}

export interface LinksSettings {
  home: string;
  missing: string;
  defaultRedirect: Redirect;
  keepDays: number;
}

export interface ApiToken {
  id: number;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface LinksInfo {
  version: string;
  links: number;
  geo: string | null;
  pendingClicks: number;
}

/** What Links said was wrong (a field and a message), or that it can't be reached. */
export class LinksError extends Error {
  readonly status: number;
  readonly field: string | null;
  constructor(message: string, status: number, field: string | null = null) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

/** The domain short links are on: a custom domain once it's live, else the free URL. */
export function shortDomain(p: Project): string {
  const hosts = servingConfig(p.id).domains;
  return hosts.find((h) => h !== p.domains[0]) ?? hosts[0] ?? p.domains[0] ?? "";
}

async function endpoint(p: Project): Promise<{ base: string; token: string }> {
  // `next dev` talks to a Links started by hand: LAYER_DEV_LINKS_URL, with LAYER_DEV_LINKS_TOKEN.
  const devToken = config.fakeAgent ? process.env.LAYER_DEV_LINKS_TOKEN : undefined;
  const token = devToken ?? projectEnv(p.id).LINKS_ADMIN_TOKEN;
  if (!token) throw new LinksError("This Links has no admin token: redeploy it from its Settings page.", 503);
  if (config.fakeAgent) return { base: process.env.LAYER_DEV_LINKS_URL ?? "http://127.0.0.1:4111", token };
  const status = await agent<{ live: "blue" | "green" | null; blue?: { port: number | null }; green?: { port: number | null } }>("unit.status", { slug: p.slug });
  const port = status.live ? status[status.live]?.port : null;
  if (!port) throw new LinksError("Links isn't running. Its Deployments page shows why.", 503);
  return { base: `http://127.0.0.1:${port}`, token };
}

/** One admin API call; Links' own errors come back as LinksError. */
export async function linksApi<T>(p: Project, path: string, init: { method?: string; body?: unknown; raw?: boolean } = {}): Promise<T> {
  const { base, token } = await endpoint(p);
  let res: Response;
  try {
    res = await fetch(`${base}/_admin/${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "Content-Type": typeof init.body === "string" ? "text/csv" : "application/json" }) },
      body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch (err) {
    throw new LinksError(`Links didn't answer (${(err as Error).message}).`, 503);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; field?: string };
    throw new LinksError(body.error ?? `Links answered HTTP ${res.status}`, res.status, body.field ?? null);
  }
  return (init.raw ? await res.text() : await res.json()) as T;
}

export const linksInfo = (p: Project) => linksApi<LinksInfo>(p, "info");

export function listLinks(p: Project, o: { q?: string; tag?: string; sort?: string; limit?: number; offset?: number } = {}): Promise<LinkList> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") params.set(k, String(v));
  return linksApi<LinkList>(p, `links?${params}`);
}

export const linkStats = (p: Project, o: { range: Range; link?: number; bots?: boolean }) =>
  linksApi<LinkStats>(p, `stats?range=${o.range}${o.link ? `&link=${o.link}` : ""}${o.bots ? "&bots=1" : ""}`);

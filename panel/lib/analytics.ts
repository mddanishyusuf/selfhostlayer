// Analytics, the web analytics integration, from the panel: its admin API on
// 127.0.0.1 at the live color's port, with the token made at install
// (ANALYTICS_ADMIN_TOKEN, kept encrypted with the project's env). The API never
// answers through Caddy, so only this server reads the numbers.
import { agent } from "./agent";
import { config } from "./config";
import { servingConfig } from "./domains";
import { integrationFor, projectEnv, type Project } from "./projects";

/** The installed Analytics, if any. */
export const analyticsInstall = () => integrationFor("analytics");

export interface Site {
  id: number;
  domain: string;
  subdomains: boolean;
  createdAt: number;
  /** Visitors in the last 24 hours, and in the last 5 minutes. */
  visitors: number;
  live: number;
}

export type Range = "today" | "24h" | "7d" | "30d" | "90d";
export const RANGES: [Range, string][] = [
  ["today", "Today"],
  ["24h", "24 hours"],
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["90d", "90 days"],
];
export const FILTERS = ["page", "entry", "exit", "referrer", "utm_source", "utm_medium", "utm_campaign", "country", "device", "browser", "os", "screen"] as const;
export type Filter = (typeof FILTERS)[number];

export interface Totals {
  visitors: number;
  visits: number;
  pageviews: number;
  bounceRate: number;
  duration: number;
}

export interface Row {
  name: string;
  visitors: number;
  count: number;
}

export interface SiteStats {
  site: Site;
  range: Range;
  from: number;
  to: number;
  bucket: "hour" | "day";
  total: Totals;
  previous: Totals;
  series: { at: number; visitors: number; visits: number; pageviews: number }[];
  pages: Row[];
  entries: Row[];
  exits: Row[];
  referrers: Row[];
  utmSources: Row[];
  utmMediums: Row[];
  utmCampaigns: Row[];
  countries: Row[];
  devices: Row[];
  browsers: Row[];
  os: Row[];
  screens: Row[];
  events: Row[];
}

export interface AnalyticsSettings {
  keepDays: number;
}

export class AnalyticsError extends Error {
  readonly status: number;
  readonly field: string | null;
  constructor(message: string, status: number, field: string | null = null) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

/** Where sites load the script from: a custom domain once it's live, else the free URL. */
export function scriptDomain(p: Project): string {
  const hosts = servingConfig(p.id).domains;
  return hosts.find((h) => h !== p.domains[0]) ?? hosts[0] ?? p.domains[0] ?? "";
}

export const snippet = (p: Project, site: string) => `<script defer src="https://${scriptDomain(p)}/script.js" data-site="${site}"></script>`;

async function endpoint(p: Project): Promise<{ base: string; token: string }> {
  // `next dev` talks to an Analytics started by hand: LAYER_DEV_ANALYTICS_URL, with LAYER_DEV_ANALYTICS_TOKEN.
  const devToken = config.fakeAgent ? process.env.LAYER_DEV_ANALYTICS_TOKEN : undefined;
  const token = devToken ?? projectEnv(p.id).ANALYTICS_ADMIN_TOKEN;
  if (!token) throw new AnalyticsError("This Analytics has no admin token: redeploy it from its Settings page.", 503);
  if (config.fakeAgent) return { base: process.env.LAYER_DEV_ANALYTICS_URL ?? "http://127.0.0.1:4222", token };
  const status = await agent<{ live: "blue" | "green" | null; blue?: { port: number | null }; green?: { port: number | null } }>("unit.status", { slug: p.slug });
  const port = status.live ? status[status.live]?.port : null;
  if (!port) throw new AnalyticsError("Analytics isn't running. Its Deployments page shows why.", 503);
  return { base: `http://127.0.0.1:${port}`, token };
}

/** One admin API call; Analytics' own errors come back as AnalyticsError. */
export async function analyticsApi<T>(p: Project, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { base, token } = await endpoint(p);
  let res: Response;
  try {
    res = await fetch(`${base}/_admin/${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch (err) {
    throw new AnalyticsError(`Analytics didn't answer (${(err as Error).message}).`, 503);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; field?: string };
    throw new AnalyticsError(body.error ?? `Analytics answered HTTP ${res.status}`, res.status, body.field ?? null);
  }
  return (await res.json()) as T;
}

export const listSites = async (p: Project) => (await analyticsApi<{ sites: Site[] }>(p, "sites")).sites;

export function siteStats(p: Project, site: number, range: Range, filters: Partial<Record<Filter, string>>): Promise<SiteStats> {
  const params = new URLSearchParams({ site: String(site), range });
  for (const [k, v] of Object.entries(filters)) if (v !== undefined) params.set(k, v);
  return analyticsApi<SiteStats>(p, `stats?${params}`);
}

export const liveNow = (p: Project, site: number) => analyticsApi<{ visitors: number; pages: Row[] }>(p, `live?site=${site}`);

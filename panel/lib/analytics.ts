// Analytics, the web analytics integration, from the panel: its admin API on
// 127.0.0.1 at the live color's port, with the token made at install
// (ANALYTICS_ADMIN_TOKEN, kept encrypted with the project's env). The API never
// answers through Caddy, so only this server reads the numbers.
import { redirect } from "next/navigation";
import { cache } from "react";
import { agent } from "./agent";
import { config } from "./config";
import { servingConfig } from "./domains";
import { integrationFor, listProjects, projectEnv, type Project } from "./projects";

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
  /** Whether a visit was ever counted (until then its Overview shows the line to paste). */
  seen: boolean;
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
  /** In the site's main currency; null until a payment came in. */
  revenue: { currency: string; total: RevenueTotals; previous: RevenueTotals } | null;
  goals: Goal[];
}

export interface RevenueTotals {
  /** In the currency's smallest unit, without tax. */
  amount: number;
  payments: number;
  customers: number;
  attributed: number;
  renewals: number;
}

export interface Goal {
  id: number;
  siteId: number;
  name: string;
  kind: "page" | "event";
  value: string;
  createdAt: number;
  visitors: number;
  visits: number;
  rate: number;
  revenue: number;
}

export interface PageRow {
  path: string;
  visitors: number;
  pageviews: number;
  entries: number;
  exits: number;
  bounceRate: number;
  time: number;
}

export interface Visit {
  id: string;
  startedAt: number;
  endedAt: number;
  pageviews: number;
  events: number;
  entry: string;
  exit: string;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  country: string | null;
  device: string;
  browser: string;
  os: string;
  screen: string | null;
  payments: number;
  revenue: number;
}

export type Provider = "stripe" | "polar" | "dodo";
export const PROVIDERS: { id: Provider; name: string }[] = [
  { id: "stripe", name: "Stripe" },
  { id: "polar", name: "Polar" },
  { id: "dodo", name: "Dodo Payments" },
];

export interface Journey {
  visit: Visit;
  currency: string | null;
  steps: { at: number; name: string; path: string; props: Record<string, string> | null }[];
  payments: { provider: Provider; id: string; at: number; amount: number; currency: string; renewal: boolean }[];
}

export interface Realtime {
  visitors: number;
  recent: number;
  minutes: { at: number; visitors: number; pageviews: number }[];
  pages: Row[];
  referrers: Row[];
  countries: Row[];
  devices: Row[];
  latest: { at: number; name: string; path: string; props: Record<string, string> | null; visit: string; country: string | null; device: string; browser: string; referrer: string | null }[];
}

export interface Source {
  provider: Provider;
  mode: "live" | "test";
  keyHint: string;
  syncedAt: number | null;
  error: string | null;
  errorAt: number | null;
  syncing: boolean;
  payments: number;
  createdAt: number;
}

export interface RevenueRow {
  name: string;
  amount: number;
  payments: number;
  customers: number;
  visitors: number;
}

export interface Revenue {
  currency: string | null;
  from: number;
  to: number;
  bucket: "hour" | "day";
  total: RevenueTotals;
  previous: RevenueTotals;
  visitors: number;
  series: { at: number; amount: number; payments: number }[];
  referrers: RevenueRow[];
  utmSources: RevenueRow[];
  utmCampaigns: RevenueRow[];
  entries: RevenueRow[];
  countries: RevenueRow[];
  latest: { provider: Provider; id: string; at: number; amount: number; currency: string; renewal: boolean; visit: string | null; referrer: string | null; utmSource: string | null; utmCampaign: string | null; entry: string | null; country: string | null; device: string | null }[];
  others: { currency: string; amount: number; payments: number }[];
  sources: Source[];
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

/** Domains to offer as a new site: each project's own domain once live, else its free URL, if not a site yet. */
export function suggestedDomains(sites: Site[]): string[] {
  const taken = new Set(sites.map((s) => s.domain));
  const out: string[] = [];
  for (const p of listProjects().filter((x) => x.source === "github")) {
    const hosts = servingConfig(p.id).domains;
    const host = (hosts.find((h) => h !== p.domains[0]) ?? hosts[0] ?? p.domains[0] ?? "").replace(/^www\./, "");
    if (host && !taken.has(host) && !out.includes(host)) out.push(host);
  }
  return out.slice(0, 8);
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
export async function analyticsApi<T>(p: Project, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const { base, token } = await endpoint(p);
  let res: Response;
  try {
    res = await fetch(`${base}/_admin/${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
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

/** The sites, once per request: the Analytics sidebar and the page both need them. */
export const sitesOnce = cache(listSites);

/**
 * The Analytics install and the site a page is for (from its URL), or null
 * when Analytics can't be reached (the layout says why). Anything else goes
 * back to /analytics.
 */
export async function siteFor(param: string): Promise<{ project: Project; site: Site; sites: Site[] } | null> {
  const project = analyticsInstall();
  if (!project) redirect("/analytics");
  const sites = await sitesOnce(project).catch(() => null);
  if (!sites) return null;
  const site = sites.find((s) => s.domain === decodeURIComponent(param));
  if (!site) redirect("/analytics");
  return { project, site, sites };
}

type Filters = Partial<Record<Filter, string>>;

/** A report's query: the site, the range and the filters, and anything else it takes. */
function query(site: number, range: Range | null, filters: Filters, extra: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams({ site: String(site), ...(range ? { range } : {}) });
  // A filter's "" means none (no referrer, say), so it's kept; an empty search isn't.
  for (const [k, v] of Object.entries(filters)) if (v !== undefined) params.set(k, v);
  for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);
  return params.toString();
}

export const siteStats = (p: Project, site: number, range: Range, filters: Filters) => analyticsApi<SiteStats>(p, `stats?${query(site, range, filters)}`);

export const liveNow = (p: Project, site: number) => analyticsApi<{ visitors: number; pages: Row[] }>(p, `live?site=${site}`);

export const realtimeOf = (p: Project, site: number) => analyticsApi<Realtime>(p, `realtime?site=${site}`);

export const pagesOf = async (p: Project, site: number, range: Range, filters: Filters, q?: string) => (await analyticsApi<{ pages: PageRow[] }>(p, `pages?${query(site, range, filters, { q })}`)).pages;

export const visitsOf = (p: Project, site: number, range: Range, filters: Filters, o: { q?: string; goal?: string; paid?: boolean; page?: number }) =>
  analyticsApi<{ visits: Visit[]; total: number; page: number; pageSize: number; currency: string | null }>(p, `visits?${query(site, range, filters, { q: o.q, goal: o.goal, paid: o.paid ? "1" : undefined, page: o.page && o.page > 1 ? String(o.page) : undefined })}`);

export const journeyOf = (p: Project, site: number, visit: string) => analyticsApi<Journey>(p, `visits/${encodeURIComponent(visit)}?site=${site}`);

export const outboundOf = async (p: Project, site: number, range: Range, filters: Filters) => (await analyticsApi<{ links: { url: string; visitors: number; clicks: number }[] }>(p, `outbound?${query(site, range, filters)}`)).links;

/** The goals with their numbers, and the currency their revenue is in (null before any payment). */
export const goalsOf = (p: Project, site: number, range: Range, filters: Filters) => analyticsApi<{ goals: Goal[]; currency: string | null }>(p, `goals?${query(site, range, filters)}`);

export const revenueOf = (p: Project, site: number, range: Range, filters: Filters) => analyticsApi<Revenue>(p, `revenue?${query(site, range, filters)}`);

export const sourcesOf = async (p: Project, site: number) => (await analyticsApi<{ sources: Source[] }>(p, `sources?site=${site}`)).sources;

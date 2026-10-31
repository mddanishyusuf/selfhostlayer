import { ChartColumnIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { BarChart } from "@/components/bar-chart";
import { AddSiteButton, FirstSite, RemoveSite, Snippet, SubdomainsToggle } from "@/components/analytics-forms";
import { Icon } from "@/components/icon";
import { InstallButton } from "@/components/integrations";
import { CARD, Notice, PageHeader, Section, Segmented, Stats, TileIcon } from "@/components/page";
import { Pill, cx } from "@/components/ui";
import { analyticsInstall, FILTERS, listSites, liveNow, RANGES, siteStats, snippet, type Filter, type Range, type Row, type Site, type SiteStats } from "@/lib/analytics";
import { catalogApps } from "@/lib/catalog";
import { servingConfig } from "@/lib/domains";
import { listProjects } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics" };

type Params = { site?: string; range?: string; pages?: string; sources?: string; devices?: string } & Partial<Record<Filter, string>>;

const regions = new Intl.DisplayNames(["en"], { type: "region" });
/** 🇬🇧 United Kingdom, from GB. */
const country = (code: string) => {
  if (!code) return "Unknown";
  const flag = String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
  let name = code;
  try {
    name = regions.of(code) ?? code;
  } catch {
    // not a region code Intl knows
  }
  return `${flag} ${name}`;
};
const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : "Unknown");
const LABELS: Record<Filter, string> = { page: "page", entry: "entry page", exit: "exit page", referrer: "source", utm_source: "UTM source", utm_medium: "UTM medium", utm_campaign: "UTM campaign", country: "country", device: "device", browser: "browser", os: "OS", screen: "screen" };

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** "+12%" against the period before, or nothing when there's nothing to compare with. */
function change(now: number, before: number, lowerIsBetter = false): { text: string; good: boolean } | null {
  if (!before) return null;
  const pct = Math.round(((now - before) / before) * 100);
  if (!Number.isFinite(pct)) return null;
  return { text: `${pct > 0 ? "+" : ""}${pct}% vs before`, good: lowerIsBetter ? pct <= 0 : pct >= 0 };
}

/** The domain to suggest for a project: its own domain once live, else its free URL. */
function projectDomains(sites: Site[]): string[] {
  const taken = new Set(sites.map((s) => s.domain));
  const out: string[] = [];
  for (const p of listProjects().filter((x) => x.source === "github")) {
    const hosts = servingConfig(p.id).domains;
    const host = (hosts.find((h) => h !== p.domains[0]) ?? hosts[0] ?? p.domains[0] ?? "").replace(/^www\./, "");
    if (host && !taken.has(host) && !out.includes(host)) out.push(host);
  }
  return out.slice(0, 8);
}

/** A card of rows, each a share bar with visitors and a second count; a row filters the page by it. */
function Breakdown({
  title,
  tabs,
  rows,
  name = (s) => s || "Unknown",
  countLabel,
  filter,
  href,
  testId,
}: {
  title: string;
  tabs?: { label: string; href: string; active: boolean }[];
  rows: Row[];
  name?: (s: string) => string;
  countLabel: string;
  filter?: Filter;
  href: (filter: Filter, value: string) => string;
  testId?: string;
}) {
  const top = rows[0]?.visitors ?? 0;
  return (
    <Section title={title} aside={tabs && <Segmented items={tabs} />}>
      <div className="grid border-t border-border px-3.5 py-2.5" data-testid={testId}>
        <div className="grid grid-cols-[minmax(0,1fr)_64px_64px] gap-3 pb-1.5 text-[12px] text-dim">
          <span />
          <span className="text-right">Visitors</span>
          <span className="text-right">{countLabel}</span>
        </div>
        {rows.length === 0 && <span className="py-2 text-[12px] text-dim">Nothing yet.</span>}
        {rows.slice(0, 9).map((r) => (
          <div key={r.name} className="relative grid grid-cols-[minmax(0,1fr)_64px_64px] items-center gap-3 py-1.5 text-[13px]">
            <span className="absolute inset-y-[3px] left-0 max-w-[calc(100%-140px)] bg-track" style={{ width: `${top ? Math.max(1, (r.visitors / top) * 100) : 0}%` }} aria-hidden />
            <span className="relative truncate pl-2">
              {filter ? (
                <Link href={href(filter, r.name)} className="hover:underline" title={`Show only ${name(r.name)}`}>
                  {name(r.name)}
                </Link>
              ) : (
                name(r.name)
              )}
            </span>
            <span className="relative text-right tabular-nums">{r.visitors.toLocaleString("en")}</span>
            <span className="relative text-right tabular-nums text-muted">{r.count.toLocaleString("en")}</span>
          </div>
        ))}
        {rows.length > 9 && <span className="pt-1.5 text-[12px] text-dim">and {rows.length - 9} more</span>}
      </div>
    </Section>
  );
}

function NotInstalled({ install }: { install: React.ReactNode }) {
  return (
    <section className={cx(CARD, "grid justify-items-center gap-3 px-6 py-12 text-center")}>
      <TileIcon tone="blue">
        <Icon icon={ChartColumnIcon} size={20} />
      </TileIcon>
      <p className="text-[17px] font-bold">Cookie-free analytics for your sites</p>
      <p className="max-w-[520px] text-muted">Visitors, pages, sources, countries and devices for each site you add, with no cookies and nothing leaving this server. Analytics installs like your apps, then one line in a site&apos;s pages starts the counting.</p>
      {install}
    </section>
  );
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireUser();
  const sp = await searchParams;
  const project = analyticsInstall();
  if (!project) {
    const app = (await catalogApps().catch(() => [])).find((a) => a.id === "analytics");
    const version = app?.versions.find((v) => v.supported);
    return (
      <>
        <PageHeader title="Analytics" meta="Cookie-free, on your own server" />
        <NotInstalled install={version ? <InstallButton app="analytics" /> : app ? <Pill outline>Needs {app.versions[0]!.minPanel} or newer</Pill> : <Pill outline>Coming soon to the catalog</Pill>} />
      </>
    );
  }

  let sites: Site[] = [];
  let problem: string | null = null;
  try {
    sites = await listSites(project);
  } catch (err) {
    problem = (err as Error).message;
  }
  const suggestions = projectDomains(sites);
  if (problem || sites.length === 0) {
    return (
      <>
        <PageHeader title="Analytics" meta="Cookie-free, on your own server" />
        {problem ? (
          <Notice lead="Not reachable" tone="err">
            {problem}
          </Notice>
        ) : (
          <section className={CARD}>
            <div className="px-3.5 pt-3.5">
              <h2 className="text-[14px] font-bold">Add your first site</h2>
              <p className="text-[12px] text-muted">A domain whose pages will send visits here.</p>
            </div>
            <FirstSite suggestions={suggestions} />
          </section>
        )}
      </>
    );
  }

  const site = sites.find((s) => s.id === Number(sp.site)) ?? sites[0]!;
  const range: Range = RANGES.some(([r]) => r === sp.range) ? (sp.range as Range) : "7d";
  const filters: Partial<Record<Filter, string>> = {};
  for (const f of FILTERS) if (sp[f] !== undefined) filters[f] = sp[f];
  let stats: SiteStats | null = null;
  let now: { visitors: number } | null = null;
  try {
    [stats, now] = await Promise.all([siteStats(project, site.id, range, filters), liveNow(project, site.id)]);
  } catch (err) {
    problem = (err as Error).message;
  }

  const href = (next: Partial<Record<keyof Params, string | null>>) => {
    const p = new URLSearchParams();
    const merged: Record<string, string | null | undefined> = { ...sp, site: String(site.id), ...next };
    for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== null) p.set(k, v);
    if (p.get("range") === "7d") p.delete("range");
    return `/analytics?${p}`;
  };
  const filterHref = (f: Filter, value: string) => href({ [f]: value });
  const tab = (key: "pages" | "sources" | "devices", items: [string, string][]) =>
    items.map(([value, label], i) => ({ label, href: href({ [key]: i === 0 ? null : value }), active: (sp[key] ?? items[0]![0]) === value }));
  const t = stats?.total;
  const p = stats?.previous;

  return (
    <>
      <PageHeader
        title="Analytics"
        crumb={site.domain}
        meta={sites.length > 1 ? undefined : "Cookie-free, on your own server"}
        actions={<AddSiteButton suggestions={suggestions} />}
      />
      <div className="flex flex-wrap items-center gap-2.5">
        {sites.length > 1 && <Segmented items={sites.map((s) => ({ href: `/analytics?site=${s.id}${range !== "7d" ? `&range=${range}` : ""}`, label: s.domain, count: s.visitors, active: s.id === site.id }))} />}
        <Segmented className="sm:ml-auto" items={RANGES.map(([r, label]) => ({ href: href({ range: r }), label, active: range === r }))} />
      </div>
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      {Object.keys(filters).length > 0 && (
        <div className="flex flex-wrap items-center gap-2" data-testid="filters">
          <span className="text-[12px] text-muted">Only:</span>
          {Object.entries(filters).map(([f, v]) => (
            <Link key={f} href={href({ [f]: null })} className="inline-flex items-center gap-1.5 border border-border bg-card px-2 py-0.5 text-[12px] hover:bg-hover" title="Remove this filter">
              {LABELS[f as Filter]}: <b className="font-medium">{f === "country" ? country(v ?? "") : v || "none"}</b>
              <Icon icon={XIcon} size={12} />
            </Link>
          ))}
        </div>
      )}
      {stats && t && p && (
        <>
          <Stats
            items={[
              { label: "Visitors", value: t.visitors.toLocaleString("en"), detail: now ? `${now.visitors} on the site now` : change(t.visitors, p.visitors)?.text },
              { label: "Visits", value: t.visits.toLocaleString("en"), detail: change(t.visits, p.visits)?.text ?? "Nothing before to compare" },
              { label: "Pageviews", value: t.pageviews.toLocaleString("en"), detail: change(t.pageviews, p.pageviews)?.text ?? "Nothing before to compare" },
              { label: "Bounce rate", value: `${Math.round(t.bounceRate * 100)}%`, detail: "Visits that saw one page" },
              { label: "Visit time", value: duration(t.duration), detail: "On average" },
            ]}
          />
          <Section title="Visitors" description={stats.bucket === "hour" ? "By the hour, in UTC" : "By the day, in UTC"}>
            <div className="border-t border-border px-3.5 pt-5">
              <BarChart
                points={stats.series.map((s) => ({ at: s.at, value: s.visitors, detail: `${s.pageviews} pageview${s.pageviews === 1 ? "" : "s"}` }))}
                bucket={stats.bucket}
                noun={["visitor", "visitors"]}
                testId="visitors-chart"
              />
            </div>
          </Section>
          <div className="grid gap-3.5 lg:grid-cols-2">
            {sp.pages === "entries" ? (
              <Breakdown title="Pages" tabs={tab("pages", [["top", "Top"], ["entries", "Entry"], ["exits", "Exit"]])} rows={stats.entries} countLabel="Visits" filter="entry" href={filterHref} />
            ) : sp.pages === "exits" ? (
              <Breakdown title="Pages" tabs={tab("pages", [["top", "Top"], ["entries", "Entry"], ["exits", "Exit"]])} rows={stats.exits} countLabel="Visits" filter="exit" href={filterHref} />
            ) : (
              <Breakdown title="Pages" tabs={tab("pages", [["top", "Top"], ["entries", "Entry"], ["exits", "Exit"]])} rows={stats.pages} countLabel="Views" filter="page" href={filterHref} testId="top-pages" />
            )}
            {sp.sources === "utm_source" ? (
              <Breakdown title="Sources" tabs={tab("sources", [["referrer", "Sites"], ["utm_source", "UTM source"], ["utm_medium", "Medium"], ["utm_campaign", "Campaign"]])} rows={stats.utmSources} countLabel="Visits" filter="utm_source" href={filterHref} name={(s) => s || "None"} />
            ) : sp.sources === "utm_medium" ? (
              <Breakdown title="Sources" tabs={tab("sources", [["referrer", "Sites"], ["utm_source", "UTM source"], ["utm_medium", "Medium"], ["utm_campaign", "Campaign"]])} rows={stats.utmMediums} countLabel="Visits" filter="utm_medium" href={filterHref} name={(s) => s || "None"} />
            ) : sp.sources === "utm_campaign" ? (
              <Breakdown title="Sources" tabs={tab("sources", [["referrer", "Sites"], ["utm_source", "UTM source"], ["utm_medium", "Medium"], ["utm_campaign", "Campaign"]])} rows={stats.utmCampaigns} countLabel="Visits" filter="utm_campaign" href={filterHref} name={(s) => s || "None"} />
            ) : (
              <Breakdown title="Sources" tabs={tab("sources", [["referrer", "Sites"], ["utm_source", "UTM source"], ["utm_medium", "Medium"], ["utm_campaign", "Campaign"]])} rows={stats.referrers} countLabel="Visits" filter="referrer" href={filterHref} name={(s) => s || "Direct or unknown"} />
            )}
            <Breakdown title="Countries" rows={stats.countries} countLabel="Visits" filter="country" href={filterHref} name={country} />
            {sp.devices === "browsers" ? (
              <Breakdown title="Devices" tabs={tab("devices", [["devices", "Device"], ["browsers", "Browser"], ["os", "OS"], ["screens", "Screen"]])} rows={stats.browsers} countLabel="Visits" filter="browser" href={filterHref} />
            ) : sp.devices === "os" ? (
              <Breakdown title="Devices" tabs={tab("devices", [["devices", "Device"], ["browsers", "Browser"], ["os", "OS"], ["screens", "Screen"]])} rows={stats.os} countLabel="Visits" filter="os" href={filterHref} />
            ) : sp.devices === "screens" ? (
              <Breakdown title="Devices" tabs={tab("devices", [["devices", "Device"], ["browsers", "Browser"], ["os", "OS"], ["screens", "Screen"]])} rows={stats.screens} countLabel="Visits" filter="screen" href={filterHref} />
            ) : (
              <Breakdown title="Devices" tabs={tab("devices", [["devices", "Device"], ["browsers", "Browser"], ["os", "OS"], ["screens", "Screen"]])} rows={stats.devices} countLabel="Visits" filter="device" href={filterHref} name={capital} />
            )}
          </div>
          {stats.events.length > 0 && <Breakdown title="Events" rows={stats.events} countLabel="Times" href={filterHref} />}
        </>
      )}
      <Section title="Setup" description={`Paste this into every page of ${site.domain}, before </head>. It sets no cookies and is under 2 KB.`}>
        <div className="grid gap-3.5 border-t border-border px-3.5 py-3.5">
          <Snippet code={snippet(project, site.domain)} />
          <p className="text-[12px] text-muted">
            Custom events: <code className="font-mono">window.shl.track(&quot;Signup&quot;, {"{"} plan: &quot;pro&quot; {"}"})</code>. Visits from localhost and automated browsers aren&apos;t counted.
          </p>
          <SubdomainsToggle id={site.id} on={site.subdomains} />
          <div>
            <RemoveSite id={site.id} domain={site.domain} />
          </div>
        </div>
      </Section>
      <p className="text-[12px] text-dim">
        Countries come from the visitor&apos;s address, looked up on this server and never stored: data by{" "}
        <a href="https://db-ip.com" className="text-accent hover:underline">
          DB-IP
        </a>
        , CC BY 4.0.
      </p>
    </>
  );
}

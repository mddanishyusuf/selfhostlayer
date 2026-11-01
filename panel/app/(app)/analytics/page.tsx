import { ArrowDownRightIcon, ArrowUpRightIcon, ChartColumnIcon, GlobeIcon } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AddSiteButton, FirstSite } from "@/components/analytics-forms";
import { Spark } from "@/components/analytics-ui";
import { Icon } from "@/components/icon";
import { InstallButton } from "@/components/integrations";
import { CARD, Notice, PageHeader, TileIcon } from "@/components/page";
import { Pill, cx } from "@/components/ui";
import { analyticsInstall, listSites, siteStats, suggestedDomains, type Site, type SiteStats } from "@/lib/analytics";
import { catalogApps } from "@/lib/catalog";
import type { Project } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics" };

function NotInstalled({ install }: { install: React.ReactNode }) {
  return (
    <section className={cx(CARD, "grid justify-items-center gap-3 px-6 py-12 text-center")}>
      <TileIcon tone="blue">
        <Icon icon={ChartColumnIcon} size={20} />
      </TileIcon>
      <p className="text-[17px] font-bold">Cookie-free analytics for your sites</p>
      <p className="max-w-[540px] text-muted">
        Visitors, pages, sources, goals and the revenue each source brings in (Stripe, Polar, Dodo Payments) for each site you add, with no cookies and nothing leaving this server. Analytics installs like your apps, then one line in a site&apos;s pages
        starts the counting.
      </p>
      {install}
    </section>
  );
}

const GRID = "minmax(0,1.6fr) 130px 100px 168px 84px";

/** Visitors against the 24 hours before: up or down, with an arrow as well as a color. */
function Change({ now, before }: { now: number; before: number }) {
  if (!before) return <span className="text-[12px] text-dim">{now ? "New" : "–"}</span>;
  const pct = Math.round(((now - before) / before) * 100);
  const up = pct >= 0;
  return (
    <span className={cx("inline-flex items-center gap-0.5 text-[12px] tabular-nums", up ? "text-ok" : "text-err")} title={`${before.toLocaleString("en")} the 24 hours before`}>
      <Icon icon={up ? ArrowUpRightIcon : ArrowDownRightIcon} size={12} />
      {Math.abs(pct)}%
    </span>
  );
}

/** One site: its last 24 hours, and who's on it now; the row opens its Overview. */
function SiteRow({ site, stats }: { site: Site; stats: SiteStats | null }) {
  const top = stats?.referrers[0];
  return (
    <Link href={`/analytics/${site.domain}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border-soft px-3.5 py-3 text-[13px] last:border-b-0 hover:bg-hover md:grid" style={{ gridTemplateColumns: GRID }} data-testid="site-row">
      <span className="flex min-w-0 basis-full items-center gap-2.5 md:basis-auto">
        <span className="grid size-8 shrink-0 place-items-center bg-icon-tile text-icon-tile-fg">
          <Icon icon={GlobeIcon} size={15} />
        </span>
        <span className="grid min-w-0">
          <b className="truncate font-bold">{site.domain}</b>
          <span className={cx("truncate text-[12px]", site.seen === false ? "text-warn" : "text-muted")}>{site.seen === false ? "No visits yet: paste its line into the site" : top ? `Most from ${top.name || "direct visits"}` : "No visits in the last 24 hours"}</span>
        </span>
      </span>
      <span className="flex items-baseline gap-2 md:justify-end">
        <span className="text-[15px] font-bold tabular-nums">
          {site.visitors.toLocaleString("en")}
          <span className="text-[12px] font-normal text-muted md:hidden"> visitors</span>
        </span>
        {stats && <Change now={stats.total.visitors} before={stats.previous.visitors} />}
      </span>
      <span className="text-muted tabular-nums md:text-right">
        {stats ? stats.total.pageviews.toLocaleString("en") : "–"}
        <span className="text-[12px] md:hidden"> pageviews</span>
      </span>
      <span className="max-md:order-last max-md:basis-full">{stats ? <Spark series={stats.series} testId="site-spark" /> : <span className="text-[12px] text-dim">–</span>}</span>
      <span className="inline-flex items-center gap-1.5 text-[12px] md:justify-self-end" title="Visitors in the last 5 minutes">
        <span className={cx("size-1.5", site.live > 0 ? "animate-pulse bg-ok-dot" : "bg-border-strong")} />
        <span className={site.live > 0 ? "text-foreground" : "text-dim"}>{site.live > 0 ? `${site.live} on now` : "No one"}</span>
      </span>
    </Link>
  );
}

/** Every site's last 24 hours, busiest first; a site that doesn't answer still has its row. */
async function overview(project: Project, sites: Site[]): Promise<{ site: Site; stats: SiteStats | null }[]> {
  const rows = await Promise.all(sites.map(async (site) => ({ site, stats: await siteStats(project, site.id, "24h", {}).catch(() => null) })));
  return rows.sort((a, b) => b.site.visitors - a.site.visitors || a.site.domain.localeCompare(b.site.domain));
}

/** Install, or the first site; with sites, all of them to pick from (?site=<id>, the old way to pick one, opens it). */
export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ site?: string }> }) {
  await requireUser();
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
  const wanted = Number((await searchParams).site);
  const asked = sites.find((s) => s.id === wanted);
  if (asked) redirect(`/analytics/${asked.domain}`);
  if (sites.length) {
    const rows = await overview(project, sites);
    const live = sites.reduce((n, s) => n + s.live, 0);
    return (
      <>
        <PageHeader title="Analytics" meta={`${sites.length} site${sites.length === 1 ? "" : "s"}${live ? ` · ${live} on them now` : ""}`} actions={<AddSiteButton suggestions={suggestedDomains(sites)} />} />
        <section className={CARD} data-testid="sites">
          <div className="hidden h-9 items-center gap-x-4 border-b border-border px-3.5 text-[12px] text-muted md:grid" style={{ gridTemplateColumns: GRID }}>
            <span>Site</span>
            <span className="text-right">Visitors, 24h</span>
            <span className="text-right">Pageviews</span>
            <span>Last 24 hours</span>
            <span className="text-right">Now</span>
          </div>
          {rows.map((r) => (
            <SiteRow key={r.site.id} site={r.site} stats={r.stats} />
          ))}
        </section>
      </>
    );
  }
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
          <FirstSite suggestions={suggestedDomains(sites)} />
        </section>
      )}
    </>
  );
}

import Link from "next/link";
import { BarChart } from "@/components/bar-chart";
import { Snippet } from "@/components/analytics-forms";
import { Breakdown, capital, change, Controls, country, duration, filtersOf, hrefWith, rangeOf, type Search } from "@/components/analytics-ui";
import { Notice, PageHeader, Section, Stats } from "@/components/page";
import { liveNow, siteFor, siteStats, snippet, type SiteStats } from "@/lib/analytics";
import { money } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics" };

export default async function OverviewPage({ params, searchParams }: { params: Promise<{ site: string }>; searchParams: Promise<Search> }) {
  const ctx = await siteFor((await params).site);
  if (!ctx) return null;
  const { project, site } = ctx;
  const sp = await searchParams;
  const path = `/analytics/${site.domain}`;
  const range = rangeOf(sp);
  let stats: SiteStats | null = null;
  let now: { visitors: number } | null = null;
  let problem: string | null = null;
  try {
    [stats, now] = await Promise.all([siteStats(project, site.id, range, filtersOf(sp)), liveNow(project, site.id)]);
  } catch (err) {
    problem = (err as Error).message;
  }
  const filterHref = (f: string) => (value: string) => hrefWith(path, sp, { [f]: value });
  const tab = (key: "pages" | "sources" | "devices", items: [string, string][]) =>
    items.map(([value, label], i) => ({ label, href: hrefWith(path, sp, { [key]: i === 0 ? null : value }), active: (sp[key] ?? items[0]![0]) === value }));
  const t = stats?.total;
  const p = stats?.previous;
  // Analytics before 0.2.0 sends no revenue, goals or "seen".
  const rev = stats?.revenue ?? null;
  const goals = stats?.goals ?? [];

  return (
    <>
      <PageHeader title={site.domain} meta="Overview" />
      {site.seen === false && (
        <Section title="Waiting for the first visit" description={`Paste this into every page of ${site.domain}, before </head>. Visits show up within a second.`}>
          <div className="grid gap-2.5 border-t border-border px-3.5 py-3.5">
            <Snippet code={snippet(project, site.domain)} />
            <p className="text-[12px] text-muted">
              It sets no cookies. Visits from localhost and automated browsers aren&apos;t counted. More on its{" "}
              <Link href={`${path}/settings`} className="text-accent hover:underline">
                Settings
              </Link>
              .
            </p>
          </div>
        </Section>
      )}
      <Controls path={path} sp={sp} keep={["pages", "sources", "devices"]} />
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
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
          {rev && (
            <Stats
              items={[
                { label: "Revenue", value: money(rev.total.amount, rev.currency), detail: change(rev.total.amount, rev.previous.amount)?.text ?? "Without tax" },
                { label: "Payments", value: rev.total.payments.toLocaleString("en"), detail: `${rev.total.customers.toLocaleString("en")} customer${rev.total.customers === 1 ? "" : "s"}` },
                { label: "Revenue per visitor", value: money(t.visitors ? Math.round(rev.total.amount / t.visitors) : 0, rev.currency), detail: <Link href={hrefWith(`${path}/revenue`, sp, { pages: null, sources: null, devices: null })} className="text-accent hover:underline">By source</Link> },
              ]}
            />
          )}
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
              <Breakdown title="Pages" tabs={tab("pages", [["top", "Top"], ["entries", "Entry"], ["exits", "Exit"]])} rows={stats.entries} countLabel="Visits" filterHref={filterHref("entry")} />
            ) : sp.pages === "exits" ? (
              <Breakdown title="Pages" tabs={tab("pages", [["top", "Top"], ["entries", "Entry"], ["exits", "Exit"]])} rows={stats.exits} countLabel="Visits" filterHref={filterHref("exit")} />
            ) : (
              <Breakdown
                title="Pages"
                tabs={tab("pages", [["top", "Top"], ["entries", "Entry"], ["exits", "Exit"]])}
                rows={stats.pages}
                countLabel="Views"
                filterHref={filterHref("page")}
                more={stats.pages.length > 9 ? { href: hrefWith(`${path}/pages`, sp, { pages: null, sources: null, devices: null }), label: `All ${stats.pages.length} pages` } : undefined}
                testId="top-pages"
              />
            )}
            {sp.sources === "utm_source" ? (
              <Breakdown title="Sources" tabs={tab("sources", SOURCE_TABS)} rows={stats.utmSources} countLabel="Visits" filterHref={filterHref("utm_source")} name={(s) => s || "None"} />
            ) : sp.sources === "utm_medium" ? (
              <Breakdown title="Sources" tabs={tab("sources", SOURCE_TABS)} rows={stats.utmMediums} countLabel="Visits" filterHref={filterHref("utm_medium")} name={(s) => s || "None"} />
            ) : sp.sources === "utm_campaign" ? (
              <Breakdown title="Sources" tabs={tab("sources", SOURCE_TABS)} rows={stats.utmCampaigns} countLabel="Visits" filterHref={filterHref("utm_campaign")} name={(s) => s || "None"} />
            ) : (
              <Breakdown title="Sources" tabs={tab("sources", SOURCE_TABS)} rows={stats.referrers} countLabel="Visits" filterHref={filterHref("referrer")} name={(s) => s || "Direct or unknown"} />
            )}
            <Breakdown title="Countries" rows={stats.countries} countLabel="Visits" filterHref={filterHref("country")} name={country} />
            {sp.devices === "browsers" ? (
              <Breakdown title="Devices" tabs={tab("devices", DEVICE_TABS)} rows={stats.browsers} countLabel="Visits" filterHref={filterHref("browser")} />
            ) : sp.devices === "os" ? (
              <Breakdown title="Devices" tabs={tab("devices", DEVICE_TABS)} rows={stats.os} countLabel="Visits" filterHref={filterHref("os")} />
            ) : sp.devices === "screens" ? (
              <Breakdown title="Devices" tabs={tab("devices", DEVICE_TABS)} rows={stats.screens} countLabel="Visits" filterHref={filterHref("screen")} />
            ) : (
              <Breakdown title="Devices" tabs={tab("devices", DEVICE_TABS)} rows={stats.devices} countLabel="Visits" filterHref={filterHref("device")} name={capital} />
            )}
          </div>
          {(stats.events.length > 0 || goals.length > 0) && (
            <div className="grid gap-3.5 lg:grid-cols-2">
              {stats.events.length > 0 && <Breakdown title="Events" rows={stats.events} countLabel="Times" />}
              {goals.length > 0 && (
                <Breakdown
                  title="Goals"
                  rows={goals.map((g) => ({ name: g.name, visitors: g.visitors, count: Math.round(g.rate * 1000) / 10 }))}
                  countLabel="Rate %"
                  more={{ href: hrefWith(`${path}/goals`, sp, { pages: null, sources: null, devices: null }), label: "All goals" }}
                />
              )}
            </div>
          )}
        </>
      )}
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

const SOURCE_TABS: [string, string][] = [
  ["referrer", "Sites"],
  ["utm_source", "UTM source"],
  ["utm_medium", "Medium"],
  ["utm_campaign", "Campaign"],
];
const DEVICE_TABS: [string, string][] = [
  ["devices", "Device"],
  ["browsers", "Browser"],
  ["os", "OS"],
  ["screens", "Screen"],
];

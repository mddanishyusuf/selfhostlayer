import Link from "next/link";
import { BarChart } from "@/components/bar-chart";
import { Breakdown, capital, country } from "@/components/analytics-ui";
import { CARD, Notice, PageHeader, Section, Stats } from "@/components/page";
import { RefreshEvery } from "@/components/refresh";
import { cx } from "@/components/ui";
import { realtimeOf, siteFor, type Realtime } from "@/lib/analytics";

export const dynamic = "force-dynamic";
export const metadata = { title: "Realtime" };

/** What a pageview or event says in the feed. */
function said(e: Realtime["latest"][number]): React.ReactNode {
  if (e.name === "pageview") return <>Viewed <b className="font-medium">{e.path}</b></>;
  if (e.name === "Outbound link" && e.props?.url) return <>Left for <b className="font-medium">{e.props.url.replace(/^https?:\/\//, "")}</b></>;
  return (
    <>
      <b className="font-medium">{e.name}</b> on {e.path}
      {e.props && <span className="text-muted"> · {Object.entries(e.props).map(([k, v]) => `${k}: ${v}`).join(", ")}</span>}
    </>
  );
}

export default async function RealtimePage({ params }: { params: Promise<{ site: string }> }) {
  const ctx = await siteFor((await params).site);
  if (!ctx) return null;
  const { project, site } = ctx;
  const path = `/analytics/${site.domain}`;
  let r: Realtime | null = null;
  let problem: string | null = null;
  try {
    r = await realtimeOf(project, site.id);
  } catch (err) {
    problem = (err as Error).message;
  }
  const at = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });
  return (
    <>
      <RefreshEvery seconds={5} />
      <PageHeader title={site.domain} crumb="Realtime" meta="The last 30 minutes, every 5 seconds" />
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      {r && (
        <>
          <Stats
            items={[
              {
                label: "On the site now",
                value: (
                  <span className="inline-flex items-center gap-2" data-testid="realtime-now">
                    <span className={cx("size-2.5", r.visitors > 0 ? "animate-pulse bg-ok-dot" : "bg-dim")} aria-hidden />
                    {r.visitors.toLocaleString("en")}
                  </span>
                ),
                detail: "Visitors in the last 5 minutes",
              },
              { label: "Visitors", value: r.recent.toLocaleString("en"), detail: "In 30 minutes" },
              { label: "Pageviews", value: r.minutes.reduce((n, m) => n + m.pageviews, 0).toLocaleString("en"), detail: "In 30 minutes" },
            ]}
          />
          <Section title="Visitors" description="By the minute, in UTC">
            <div className="border-t border-border px-3.5 pt-5">
              <BarChart points={r.minutes.map((m) => ({ at: m.at, value: m.visitors, detail: `${m.pageviews} pageview${m.pageviews === 1 ? "" : "s"}` }))} bucket="minute" noun={["visitor", "visitors"]} />
            </div>
          </Section>
          <div className="grid gap-3.5 lg:grid-cols-2">
            <Breakdown title="Pages they're on" rows={r.pages} countLabel="Visits" />
            <Breakdown title="Sources" rows={r.referrers} countLabel="Visits" name={(s) => s || "Direct or unknown"} />
            <Breakdown title="Countries" rows={r.countries} countLabel="Visits" name={country} />
            <Breakdown title="Devices" rows={r.devices} countLabel="Visits" name={capital} />
          </div>
          <section className={CARD}>
            <div className="px-3.5 pb-2.5 pt-3.5">
              <h2 className="text-[14px] font-bold">Latest</h2>
              <p className="text-[12px] text-muted">Pageviews and events as they come, newest first. A row opens its visit.</p>
            </div>
            <div className="border-t border-border" data-testid="realtime-feed">
              {r.latest.length === 0 && <p className="px-3.5 py-6 text-center text-muted">Nothing in the last 30 minutes.</p>}
              {r.latest.map((e, i) => (
                <Link
                  key={`${e.at}-${i}`}
                  href={`${path}/users?visit=${encodeURIComponent(e.visit)}`}
                  className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-x-3 border-b border-border-soft px-3.5 py-2 text-[13px] transition-colors last:border-b-0 hover:bg-hover md:grid-cols-[64px_minmax(0,1fr)_170px_150px]"
                >
                  <span className="font-mono text-[12px] tabular-nums text-dim">{at(e.at)}</span>
                  <span className="truncate">{said(e)}</span>
                  <span className="hidden truncate text-muted md:block">{country(e.country)}</span>
                  <span className="hidden truncate text-muted md:block">
                    {capital(e.device)} · {e.browser}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        </>
      )}
    </>
  );
}

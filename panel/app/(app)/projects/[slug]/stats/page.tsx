import Link from "next/link";
import { notFound } from "next/navigation";
import { BarChart } from "@/components/bar-chart";
import { Notice, PageHeader, Section, Segmented, Stats } from "@/components/page";
import { isLinks, linksApi, linksInfo, linkStats, shortDomain, type Count, type Link as ShortLink, type LinksInfo, type LinkStats, type Range } from "@/lib/links";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Link stats" };

const RANGES: [Range, string][] = [
  ["24h", "24 hours"],
  ["7d", "7 days"],
  ["30d", "30 days"],
];

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
const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : "Other");

/** A breakdown: each name with its clicks and a bar for its share. */
function Breakdown({ title, rows, name = (s) => s || "Unknown", limit = 8 }: { title: string; rows: (Count & { href?: string })[]; name?: (s: string) => string; limit?: number }) {
  const total = rows.reduce((a, r) => a + r.clicks, 0);
  const top = rows[0]?.clicks ?? 0;
  return (
    <Section title={title}>
      <div className="grid border-t border-border px-3.5 py-2.5">
        {rows.length === 0 && <span className="py-2 text-[12px] text-dim">No clicks yet.</span>}
        {rows.slice(0, limit).map((r) => (
          <div key={r.name} className="relative grid grid-cols-[minmax(0,1fr)_auto_44px] items-center gap-3 py-1.5 text-[13px]">
            <span className="absolute inset-y-[3px] left-0 bg-track" style={{ width: `${top ? Math.max(1, (r.clicks / top) * 100) : 0}%` }} aria-hidden />
            <span className="relative truncate pl-2">{r.href ? <Link href={r.href} className="hover:underline">{name(r.name)}</Link> : name(r.name)}</span>
            <span className="relative text-right tabular-nums">{r.clicks.toLocaleString("en")}</span>
            <span className="relative text-right text-[12px] tabular-nums text-muted">{total ? Math.round((r.clicks / total) * 100) : 0}%</span>
          </div>
        ))}
        {rows.length > limit && <span className="pt-1.5 text-[12px] text-dim">and {rows.length - limit} more</span>}
      </div>
    </Section>
  );
}

export default async function StatsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ range?: string; link?: string; bots?: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project || !isLinks(project)) notFound();
  const sp = await searchParams;
  const range: Range = RANGES.some(([r]) => r === sp.range) ? (sp.range as Range) : "7d";
  const linkId = Number(sp.link) || undefined;
  const bots = sp.bots === "1";
  const domain = shortDomain(project);
  let stats: LinkStats | null = null;
  let link: ShortLink | null = null;
  let info: LinksInfo | null = null;
  let problem: string | null = null;
  try {
    [stats, link, info] = await Promise.all([linkStats(project, { range, link: linkId, bots }), linkId ? linksApi<ShortLink>(project, `links/${linkId}`) : null, linksInfo(project)]);
  } catch (err) {
    problem = (err as Error).message;
  }
  const base = `/projects/${project.slug}/stats`;
  const href = (next: { range?: Range; link?: number | null; bots?: boolean }) => {
    const p = new URLSearchParams();
    const r = next.range ?? range;
    if (r !== "7d") p.set("range", r);
    const l = next.link === undefined ? linkId : next.link;
    if (l) p.set("link", String(l));
    if (next.bots ?? bots) p.set("bots", "1");
    return p.size ? `${base}?${p}` : base;
  };
  const visitors = stats?.total.visitors ?? 0;

  return (
    <>
      <PageHeader
        title={project.slug}
        crumb="Stats"
        meta={link ? `${domain}/${link.slug} → ${link.target}` : `Every link on ${domain}`}
        actions={<Segmented items={RANGES.map(([r, label]) => ({ href: href({ range: r }), label, active: range === r }))} />}
      />
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      {link && (
        <Notice lead="One link" tone="lav">
          Only /{link.slug}.{" "}
          <Link href={href({ link: null })} className="text-accent hover:underline">
            Show every link
          </Link>
        </Notice>
      )}
      {stats && (
        <>
          <Stats
            items={[
              { label: "Clicks", value: stats.total.clicks.toLocaleString("en"), detail: bots ? "Bots included" : "People, not bots" },
              { label: "Visitors", value: visitors.toLocaleString("en"), detail: "Each counted once a day, no cookies" },
              { label: "Bots", value: stats.total.bots.toLocaleString("en"), detail: bots ? "Included above" : "Left out above" },
              link
                ? { label: "All time", value: link.clicks.toLocaleString("en"), detail: `Since ${new Date(link.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` }
                : { label: "Top link", value: <span className="text-[17px]">{stats.links[0] ? `/${stats.links[0].slug}` : "—"}</span>, detail: stats.links[0] ? `${stats.links[0].clicks} clicks` : "No clicks yet" },
            ]}
          />
          <Section
            title="Clicks"
            description={stats.bucket === "hour" ? "By the hour, in UTC" : "By the day, in UTC"}
            aside={
              <Segmented
                items={[
                  { href: href({ bots: false }), label: "People", active: !bots },
                  { href: href({ bots: true }), label: "With bots", active: bots },
                ]}
              />
            }
          >
            <div className="border-t border-border px-3.5 pt-5">
              <BarChart
                points={stats.series.map((p) => ({ at: p.at, value: p.clicks, detail: `${p.visitors} visitor${p.visitors === 1 ? "" : "s"}` }))}
                bucket={stats.bucket}
                noun={["click", "clicks"]}
                testId="clicks-chart"
              />
            </div>
          </Section>
          <div className="grid gap-3.5 lg:grid-cols-2">
            {!link && <Breakdown title="Top links" rows={stats.links.map((l) => ({ name: `/${l.slug}`, clicks: l.clicks, href: href({ link: l.id }) }))} />}
            <Breakdown title="Referrers" rows={stats.referrers} name={(s) => s || "Direct or unknown"} />
            <Breakdown title="Countries" rows={stats.countries} name={country} />
            <Breakdown title="Devices" rows={stats.devices} name={capital} />
            <Breakdown title="Browsers" rows={stats.browsers} />
            <Breakdown title="Operating systems" rows={stats.os} />
          </div>
          <p className="text-[12px] text-dim">
            Countries come from the visitor&apos;s address, looked up on this server and never stored: data by{" "}
            <a href="https://db-ip.com" className="text-accent hover:underline">
              DB-IP
            </a>
            {info?.geo ? ` (${info.geo})` : ""}, CC BY 4.0.
          </p>
        </>
      )}
    </>
  );
}

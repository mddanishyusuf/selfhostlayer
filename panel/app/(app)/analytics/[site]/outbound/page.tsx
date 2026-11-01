import { SquareArrowOutUpRightIcon } from "lucide-react";
import { Controls, filtersOf, hrefWith, rangeOf, type Search } from "@/components/analytics-ui";
import { Icon } from "@/components/icon";
import { CARD, Empty, Notice, PageHeader, Segmented } from "@/components/page";
import { outboundOf, siteFor } from "@/lib/analytics";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Outbound" };

const GRID = "minmax(0,1fr) 84px 84px";

export default async function OutboundPage({ params, searchParams }: { params: Promise<{ site: string }>; searchParams: Promise<Search & { view?: string }> }) {
  await requireUser();
  const ctx = await siteFor((await params).site);
  if (!ctx) return null;
  const { project, site } = ctx;
  // An older Analytics has no such report yet: the layout offers its update.
  if (ctx.outdated) return <PageHeader title={site.domain} crumb="Outbound" />;
  const sp = await searchParams;
  const path = `/analytics/${site.domain}/outbound`;
  let links: { url: string; visitors: number; clicks: number }[] = [];
  let problem: string | null = null;
  try {
    links = await outboundOf(project, site.id, rangeOf(sp), filtersOf(sp));
  } catch (err) {
    problem = (err as Error).message;
  }
  // By site: the links' hosts, adding up clicks (visitors can't be added across links, so the most of any one link is a floor).
  const bySite = sp.view !== "links";
  const rows = bySite
    ? [...links.reduce((m, l) => {
        // Analytics keeps only http(s) links, but an older one may have kept anything.
        const host = URL.canParse(l.url) ? new URL(l.url).host || l.url : l.url;
        const r = m.get(host) ?? { url: host, visitors: 0, clicks: 0, links: 0 };
        r.clicks += l.clicks;
        r.visitors = Math.max(r.visitors, l.visitors);
        r.links++;
        return m.set(host, r);
      }, new Map<string, { url: string; visitors: number; clicks: number; links: number }>()).values()].sort((a, b) => b.clicks - a.clicks)
    : links.map((l) => ({ ...l, links: 1 }));
  const top = Math.max(1, ...rows.map((r) => r.clicks));
  return (
    <>
      <PageHeader title={site.domain} crumb="Outbound" meta="Clicks on links to other sites" />
      <Controls path={path} sp={sp} keep={["view"]}>
        <Segmented
          items={[
            { label: "Sites", href: hrefWith(path, sp, { view: null }), active: bySite },
            { label: "Links", href: hrefWith(path, sp, { view: "links" }), active: !bySite },
          ]}
        />
      </Controls>
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      <section className={CARD} data-testid="outbound">
        <div className="grid px-3.5 py-2.5">
          <div className="grid gap-x-4 pb-1.5 text-[12px] text-dim" style={{ gridTemplateColumns: GRID }}>
            <span>{bySite ? "Site" : "Link"}</span>
            <span className="text-right">Visitors</span>
            <span className="text-right">Clicks</span>
          </div>
          {rows.length === 0 && !problem && <Empty>No clicks to other sites in this range. The script counts them by itself: nothing to add to the pages.</Empty>}
          {rows.map((r) => (
            <div key={r.url} className="relative grid items-center gap-x-4 py-1.5 text-[13px]" style={{ gridTemplateColumns: GRID }}>
              <span className="absolute inset-y-[3px] left-0 max-w-[calc(100%-200px)] bg-track" style={{ width: `${Math.max(1, (r.clicks / top) * 100)}%` }} aria-hidden />
              <a href={bySite ? `https://${r.url}` : r.url} target="_blank" rel="noreferrer noopener" className="relative flex min-w-0 items-center gap-1.5 pl-2 hover:underline">
                <span className="truncate">{bySite ? r.url : r.url.replace(/^https?:\/\//, "")}</span>
                {bySite && r.links > 1 && <span className="shrink-0 text-[12px] text-dim">{r.links} links</span>}
                <Icon icon={SquareArrowOutUpRightIcon} size={12} className="text-dim" />
              </a>
              <span className="relative text-right tabular-nums">{r.visitors.toLocaleString("en")}</span>
              <span className="relative text-right tabular-nums text-muted">{r.clicks.toLocaleString("en")}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

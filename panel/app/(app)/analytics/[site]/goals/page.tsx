import { TargetIcon } from "lucide-react";
import Link from "next/link";
import { GoalActions, NewGoalButton } from "@/components/analytics-forms";
import { Controls, filtersOf, hrefWith, rangeOf, type Search } from "@/components/analytics-ui";
import { Icon } from "@/components/icon";
import { CARD, Notice, PageHeader, TileIcon } from "@/components/page";
import { goalsOf, siteFor, type Goal } from "@/lib/analytics";
import { money } from "@/lib/money";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Goals" };

const GRID = "minmax(0,1fr) 90px 90px 80px 96px 32px";

export default async function GoalsPage({ params, searchParams }: { params: Promise<{ site: string }>; searchParams: Promise<Search> }) {
  await requireUser();
  const ctx = await siteFor((await params).site);
  if (!ctx) return null;
  const { project, site } = ctx;
  // An older Analytics has no such report yet: the layout offers its update.
  if (ctx.outdated) return <PageHeader title={site.domain} crumb="Goals" />;
  const sp = await searchParams;
  const path = `/analytics/${site.domain}/goals`;
  let goals: Goal[] = [];
  let currency: string | null = null;
  let problem: string | null = null;
  try {
    ({ goals, currency } = await goalsOf(project, site.id, rangeOf(sp), filtersOf(sp)));
  } catch (err) {
    problem = (err as Error).message;
  }
  return (
    <>
      <PageHeader title={site.domain} crumb="Goals" meta="Visitors who reached a page or sent an event" actions={<NewGoalButton site={site.id} />} />
      {goals.length > 0 && <Controls path={path} sp={sp} />}
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      {!problem && goals.length === 0 ? (
        <section className={`${CARD} grid justify-items-center gap-3 px-6 py-12 text-center`}>
          <TileIcon tone="gold">
            <Icon icon={TargetIcon} size={20} />
          </TileIcon>
          <p className="text-[17px] font-bold">What should a visit lead to?</p>
          <p className="max-w-[520px] text-muted">
            A goal is a page (/thank-you, or /docs/* for any page under /docs) or a custom event (<code className="font-mono text-[12.5px]">window.shl.track(&quot;Signup&quot;)</code>). Each one counts the visitors who reached it, what share of all visitors
            that is, and the revenue those visits brought in.
          </p>
          <NewGoalButton site={site.id} />
        </section>
      ) : (
        goals.length > 0 && (
          <section className={CARD} data-testid="goals">
            <div className="hidden h-9 items-center gap-x-4 border-b border-border px-3.5 text-[12px] text-muted md:grid" style={{ gridTemplateColumns: GRID }}>
              <span>Goal</span>
              <span className="text-right">Visitors</span>
              <span className="text-right" title="Of all visitors in the range">
                Rate
              </span>
              <span className="text-right">Visits</span>
              <span className="text-right">Revenue</span>
              <span />
            </div>
            {goals.map((g) => (
              <div key={g.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-soft px-3.5 py-2.5 text-[13px] last:border-b-0 md:grid" style={{ gridTemplateColumns: GRID }} data-testid="goal-row">
                <span className="grid min-w-0 basis-full md:basis-auto">
                  <Link href={hrefWith(`/analytics/${site.domain}/users`, { range: sp.range }, { goal: String(g.id) })} className="truncate font-bold hover:underline" title="See the visits that reached it">
                    {g.name}
                  </Link>
                  <span className="truncate text-[12px] text-muted">
                    {g.kind === "page" ? "Visits " : "Sends "}
                    <code className="font-mono">{g.value}</code>
                  </span>
                </span>
                <span className="text-right tabular-nums">{g.visitors.toLocaleString("en")}</span>
                <span className="text-right tabular-nums">
                  <span className="relative inline-block h-1.5 w-10 bg-track align-middle" aria-hidden>
                    <span className="absolute inset-y-0 left-0 bg-chart" style={{ width: `${Math.min(100, g.rate * 100)}%` }} />
                  </span>{" "}
                  {(g.rate * 100).toFixed(g.rate < 0.1 && g.rate > 0 ? 1 : 0)}%
                </span>
                <span className="text-right tabular-nums text-muted">{g.visits.toLocaleString("en")}</span>
                <span className="text-right tabular-nums">{currency ? money(g.revenue, currency) : <span className="text-dim">–</span>}</span>
                <span className="justify-self-end">
                  <GoalActions site={site.id} domain={site.domain} goal={{ id: g.id, name: g.name, kind: g.kind, value: g.value }} />
                </span>
              </div>
            ))}
          </section>
        )
      )}
    </>
  );
}

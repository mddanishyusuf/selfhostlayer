import { ChevronLeftIcon, ChevronRightIcon, CircleDollarSignIcon, FileTextIcon, SearchIcon, SquareArrowOutUpRightIcon, XIcon, ZapIcon } from "lucide-react";
import Link from "next/link";
import { CloseOnEscape, GoalPicker } from "@/components/analytics-forms";
import { capital, Controls, country, duration, filtersOf, hrefWith, rangeOf, sourceOf, when, type Search } from "@/components/analytics-ui";
import { Icon } from "@/components/icon";
import { CARD, Empty, KeyValues, Notice, PageHeader, Segmented } from "@/components/page";
import { buttonClass, NO_AUTOFILL, Pill, cx } from "@/components/ui";
import { goalsOf, journeyOf, siteFor, visitsOf, type Goal, type Journey, type Visit } from "@/lib/analytics";
import { money } from "@/lib/money";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Users" };

type Params = Search & { q?: string; goal?: string; paid?: string; page?: string; visit?: string };
const GRID = "118px minmax(0,1fr) minmax(0,1.3fr) minmax(0,1fr) 84px";

const pages = (n: number) => `${n} page${n === 1 ? "" : "s"}`;

function VisitRow({ v, href, currency }: { v: Visit; href: string; currency: string | null }) {
  return (
    <Link href={href} scroll={false} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-soft px-3.5 py-2.5 text-[13px] transition-colors last:border-b-0 hover:bg-hover md:grid" style={{ gridTemplateColumns: GRID }} data-testid="visit-row">
      <span className="grid basis-full md:basis-auto">
        <span className="tabular-nums">{when(v.startedAt)}</span>
        <span className="text-[12px] text-muted">
          {pages(v.pageviews)} · {duration(v.endedAt - v.startedAt)}
        </span>
      </span>
      <span className="grid min-w-0">
        <span className="truncate">{sourceOf(v)}</span>
        {v.utmCampaign && <span className="truncate text-[12px] text-muted">{v.utmCampaign}</span>}
      </span>
      <span className="grid min-w-0">
        <span className="truncate">
          {v.entry}
          {v.exit !== v.entry && <span className="text-muted"> → {v.exit}</span>}
        </span>
        {v.events > 0 && <span className="text-[12px] text-muted">{v.events === 1 ? "1 event" : `${v.events} events`}</span>}
      </span>
      <span className="grid min-w-0 text-muted">
        <span className="truncate text-foreground">{country(v.country)}</span>
        <span className="truncate text-[12px]">
          {capital(v.device)} · {v.browser} · {v.os}
        </span>
      </span>
      <span className="text-right tabular-nums">{v.payments > 0 && currency ? <b className="font-bold text-teal">{money(v.revenue, currency)}</b> : <span className="text-dim">–</span>}</span>
    </Link>
  );
}

/** A visit as it went: where it came from, then each page and event in order, and what it paid. */
function JourneyDrawer({ j, error, close }: { j: Journey | null; error: string | null; close: string }) {
  const v = j?.visit;
  const offset = (at: number) => {
    const s = Math.max(0, Math.round((at - (v?.startedAt ?? at)) / 1000));
    return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Visit">
      <CloseOnEscape href={close} />
      <Link href={close} scroll={false} aria-label="Close" className="absolute inset-0 bg-black/40" />
      <aside className="absolute inset-y-0 right-0 flex w-[460px] max-w-full flex-col border-l border-border bg-card shadow-pop" data-testid="journey">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-[14px] font-bold">Visit</h2>
            {v && (
              <p className="truncate text-[12px] text-muted">
                {when(v.startedAt)} UTC · {duration(v.endedAt - v.startedAt)}
              </p>
            )}
          </div>
          <Link href={close} scroll={false} className="grid size-8 place-items-center text-muted transition-colors hover:bg-hover hover:text-foreground" aria-label="Close">
            <Icon icon={XIcon} size={16} />
          </Link>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error && <p className="px-4 py-6 text-muted">{error}</p>}
          {v && j && (
            <>
              <KeyValues
                flush
                items={[
                  ["Source", sourceOf(v)],
                  ...(v.utmSource || v.utmMedium || v.utmCampaign ? [["UTM", [v.utmSource, v.utmMedium, v.utmCampaign].filter(Boolean).join(" · ")] as [string, string]] : []),
                  ["Country", country(v.country)],
                  ["Device", `${capital(v.device)}${v.screen ? ` (${v.screen})` : ""}`],
                  ["Browser", `${v.browser} on ${v.os}`],
                ]}
              />
              {j.payments.length > 0 && (
                <div className="border-t border-border px-4 py-3">
                  <h3 className="mb-1.5 text-[12px] text-muted">Paid</h3>
                  {j.payments.map((p) => (
                    <div key={p.id} className="flex items-center gap-2 py-1 text-[13px]">
                      <Icon icon={CircleDollarSignIcon} size={14} className="text-teal" />
                      <b className="font-bold">{money(p.amount, p.currency)}</b>
                      <span className="text-muted">
                        {p.provider === "dodo" ? "Dodo Payments" : capital(p.provider)} · {when(p.at)}
                      </span>
                      {p.renewal && <Pill outline>Renewal</Pill>}
                    </div>
                  ))}
                </div>
              )}
              <ol className="border-t border-border px-4 py-3" data-testid="journey-steps">
                {j.steps.map((s, i) => {
                  const out = s.name === "Outbound link";
                  return (
                    <li key={i} className="relative grid grid-cols-[46px_18px_minmax(0,1fr)] items-start gap-2 py-1.5 text-[13px]">
                      <span className="pt-px font-mono text-[11.5px] tabular-nums text-dim">{offset(s.at)}</span>
                      <span className={cx("grid place-items-center pt-0.5", s.name === "pageview" ? "text-muted" : out ? "text-tile-blue" : "text-tile-gold")}>
                        <Icon icon={s.name === "pageview" ? FileTextIcon : out ? SquareArrowOutUpRightIcon : ZapIcon} size={13} />
                      </span>
                      <span className="min-w-0 break-words">
                        {s.name === "pageview" ? (
                          s.path
                        ) : out ? (
                          <>Left for {s.props?.url?.replace(/^https?:\/\//, "") ?? "another site"}</>
                        ) : (
                          <>
                            <b className="font-medium">{s.name}</b> <span className="text-muted">on {s.path}</span>
                            {s.props && <span className="block text-[12px] text-muted">{Object.entries(s.props).map(([k, val]) => `${k}: ${val}`).join(" · ")}</span>}
                          </>
                        )}
                      </span>
                    </li>
                  );
                })}
                {j.steps.length === 0 && <li className="py-2 text-muted">Its pages are past the time visits are kept.</li>}
              </ol>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

export default async function UsersPage({ params, searchParams }: { params: Promise<{ site: string }>; searchParams: Promise<Params> }) {
  await requireUser();
  const ctx = await siteFor((await params).site);
  if (!ctx) return null;
  const { project, site } = ctx;
  // An older Analytics has no such report yet: the layout offers its update.
  if (ctx.outdated) return <PageHeader title={site.domain} crumb="Users" />;
  const sp = await searchParams;
  const path = `/analytics/${site.domain}/users`;
  const q = sp.q?.trim() ?? "";
  const page = Math.max(1, Math.floor(Number(sp.page)) || 1);
  const range = rangeOf(sp);
  const filters = filtersOf(sp);
  let list: Awaited<ReturnType<typeof visitsOf>> | null = null;
  let goals: Goal[] = [];
  let problem: string | null = null;
  try {
    [list, { goals }] = await Promise.all([visitsOf(project, site.id, range, filters, { q, goal: sp.goal, paid: sp.paid === "1", page }), goalsOf(project, site.id, range, {})]);
  } catch (err) {
    problem = (err as Error).message;
  }
  let journey: Journey | null = null;
  let journeyError: string | null = null;
  if (sp.visit) {
    try {
      journey = await journeyOf(project, site.id, sp.visit);
    } catch (err) {
      journeyError = (err as Error).message;
    }
  }
  const pages_ = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;
  const goalHrefs = Object.fromEntries([["", hrefWith(path, { ...sp, visit: undefined, page: undefined }, { goal: null })], ...goals.map((g) => [String(g.id), hrefWith(path, { ...sp, visit: undefined, page: undefined }, { goal: String(g.id) })])]);
  return (
    <>
      <PageHeader title={site.domain} crumb="Users" meta={list ? `${list.total.toLocaleString("en")} visit${list.total === 1 ? "" : "s"} in this range` : "Each visit, as it went"} />
      <Controls path={path} sp={sp} keep={["q", "goal", "paid"]}>
        <form action={path} className="flex min-w-[220px] flex-1 items-center gap-2 border border-border bg-field px-2.5 sm:max-w-[300px]" role="search">
          {Object.entries({ ...sp, q: undefined, page: undefined, visit: undefined })
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
          <Icon icon={SearchIcon} size={14} className="text-muted" />
          <input name="q" defaultValue={q} placeholder="A page, source or campaign" className="h-[33px] min-w-0 flex-1 bg-transparent outline-none placeholder:text-placeholder" {...NO_AUTOFILL} />
        </form>
        {goals.length > 0 && <GoalPicker goals={goals} value={sp.goal ?? ""} hrefs={goalHrefs} />}
        <Segmented
          items={[
            { label: "All", href: hrefWith(path, { ...sp, visit: undefined, page: undefined }, { paid: null }), active: sp.paid !== "1" },
            { label: "Paying", href: hrefWith(path, { ...sp, visit: undefined, page: undefined }, { paid: "1" }), active: sp.paid === "1" },
          ]}
        />
      </Controls>
      <p className="text-[12px] text-muted">With no cookies, nobody is followed from one day to the next: each row is one visit, its pages less than 30 minutes apart.</p>
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      {list && (
        <section className={CARD} data-testid="visits">
          <div className="hidden h-9 items-center gap-x-4 border-b border-border px-3.5 text-[12px] text-muted md:grid" style={{ gridTemplateColumns: GRID }}>
            <span>Started (UTC)</span>
            <span>Source</span>
            <span>Pages</span>
            <span>Where, on what</span>
            <span className="text-right">Revenue</span>
          </div>
          {list.visits.length === 0 && <Empty>{q || sp.goal || sp.paid ? "No visit matches." : "No visits in this range."}</Empty>}
          {list.visits.map((v) => (
            <VisitRow key={v.id} v={v} currency={list.currency} href={hrefWith(path, { ...sp }, { visit: v.id })} />
          ))}
          {pages_ > 1 && (
            <div className="flex items-center justify-between border-t border-border px-3.5 py-2.5 text-[12px] text-muted">
              <span>
                Page {list.page} of {pages_}
              </span>
              <span className="flex gap-1.5">
                {list.page > 1 && (
                  <Link href={hrefWith(path, { ...sp, visit: undefined }, { page: list.page === 2 ? null : String(list.page - 1) })} className={buttonClass("secondary", "sm")} scroll={false}>
                    <Icon icon={ChevronLeftIcon} size={13} /> Newer
                  </Link>
                )}
                {list.page < pages_ && (
                  <Link href={hrefWith(path, { ...sp, visit: undefined }, { page: String(list.page + 1) })} className={buttonClass("secondary", "sm")} scroll={false}>
                    Older <Icon icon={ChevronRightIcon} size={13} />
                  </Link>
                )}
              </span>
            </div>
          )}
        </section>
      )}
      {sp.visit && <JourneyDrawer j={journey} error={journeyError} close={hrefWith(path, sp, { visit: null })} />}
    </>
  );
}

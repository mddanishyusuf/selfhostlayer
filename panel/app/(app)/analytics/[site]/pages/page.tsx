import { ArrowDownIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { Controls, duration, filtersOf, hrefWith, rangeOf, type Search } from "@/components/analytics-ui";
import { Icon } from "@/components/icon";
import { CARD, Empty, Notice, PageHeader } from "@/components/page";
import { NO_AUTOFILL, cx } from "@/components/ui";
import { pagesOf, siteFor, type PageRow } from "@/lib/analytics";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pages" };

const COLUMNS: { key: keyof PageRow; label: string; title?: string; show: (r: PageRow) => string }[] = [
  { key: "visitors", label: "Visitors", show: (r) => r.visitors.toLocaleString("en") },
  { key: "pageviews", label: "Views", show: (r) => r.pageviews.toLocaleString("en") },
  { key: "entries", label: "Entries", title: "Visits that started here", show: (r) => r.entries.toLocaleString("en") },
  { key: "exits", label: "Exits", title: "Visits that ended here", show: (r) => r.exits.toLocaleString("en") },
  { key: "bounceRate", label: "Bounce", title: "Of the visits that started here, the ones that saw nothing else", show: (r) => (r.entries ? `${Math.round(r.bounceRate * 100)}%` : "–") },
  { key: "time", label: "Time", title: "Average time until the next page, or the end of the visit", show: (r) => duration(r.time) },
];
const GRID = "minmax(0,1fr) repeat(6, 76px)";
const PAGE = 100;

export default async function PagesPage({ params, searchParams }: { params: Promise<{ site: string }>; searchParams: Promise<Search & { q?: string; sort?: string; more?: string }> }) {
  const ctx = await siteFor((await params).site);
  if (!ctx) return null;
  const { project, site } = ctx;
  const sp = await searchParams;
  const path = `/analytics/${site.domain}/pages`;
  const q = sp.q?.trim() ?? "";
  let rows: PageRow[] = [];
  let problem: string | null = null;
  try {
    rows = await pagesOf(project, site.id, rangeOf(sp), filtersOf(sp), q);
  } catch (err) {
    problem = (err as Error).message;
  }
  const sort = COLUMNS.find((c) => c.key === sp.sort)?.key ?? "visitors";
  rows = rows.toSorted((a, b) => Number(b[sort]) - Number(a[sort]) || b.visitors - a.visitors || a.path.localeCompare(b.path));
  const shown = sp.more === "1" ? rows : rows.slice(0, PAGE);
  return (
    <>
      <PageHeader title={site.domain} crumb="Pages" meta={rows.length ? `${rows.length.toLocaleString("en")} page${rows.length === 1 ? "" : "s"} in this range` : "Every page, with its numbers"} />
      <Controls path={path} sp={sp} keep={["q", "sort"]}>
        <form action={path} className="flex min-w-[220px] flex-1 items-center gap-2 border border-border bg-field px-2.5 sm:max-w-[320px]" role="search">
          {Object.entries(sp)
            .filter(([k, v]) => k !== "q" && k !== "more" && v !== undefined)
            .map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
          <Icon icon={SearchIcon} size={14} className="text-muted" />
          <input name="q" defaultValue={q} placeholder="Search pages" className="h-[33px] min-w-0 flex-1 bg-transparent outline-none placeholder:text-placeholder" {...NO_AUTOFILL} data-testid="pages-search" />
        </form>
      </Controls>
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      <section className={CARD} data-testid="pages-table">
        <div className="hidden h-9 items-center gap-x-4 border-b border-border px-3.5 text-[12px] text-muted md:grid" style={{ gridTemplateColumns: GRID }}>
          <span>Page</span>
          {COLUMNS.map((c) => (
            <Link key={c.key} href={hrefWith(path, sp, { sort: c.key === "visitors" ? null : c.key, more: null })} title={c.title ? `${c.title}. Sort by it` : "Sort by it"} className={cx("inline-flex items-center justify-end gap-1 hover:text-foreground", sort === c.key && "font-bold text-foreground")} scroll={false}>
              {c.label}
              {sort === c.key && <Icon icon={ArrowDownIcon} size={11} />}
            </Link>
          ))}
        </div>
        {shown.length === 0 && !problem && <Empty>{q ? `No page has “${q}” in it.` : "No pageviews in this range."}</Empty>}
        {shown.map((r) => (
          <div key={r.path} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-soft px-3.5 py-2 text-[13px] last:border-b-0 md:grid" style={{ gridTemplateColumns: GRID }}>
            <Link href={hrefWith(`/analytics/${site.domain}`, { range: sp.range }, { page: r.path })} className="min-w-0 basis-full truncate hover:underline md:basis-auto" title={`Show only visits that saw ${r.path}`}>
              {r.path}
            </Link>
            {COLUMNS.map((c) => (
              <span key={c.key} className={cx("text-right tabular-nums max-md:text-[12px]", c.key === "visitors" ? "" : "text-muted")}>
                <span className="mr-1 text-dim md:hidden">{c.label}</span>
                {c.show(r)}
              </span>
            ))}
          </div>
        ))}
        {rows.length > shown.length && (
          <div className="border-t border-border px-3.5 py-2.5 text-[12px]">
            <Link href={hrefWith(path, sp, { more: "1" })} className="text-accent hover:underline" scroll={false}>
              Show all {rows.length.toLocaleString("en")}
            </Link>
          </div>
        )}
      </section>
    </>
  );
}

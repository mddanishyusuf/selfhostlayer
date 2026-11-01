// What Analytics' pages share: the range and filters (kept in the URL), cards
// of rows with share bars, and how countries, times and money read.
import { XIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { FILTERS, RANGES, type Filter, type Range, type Row } from "@/lib/analytics";
import { Icon } from "./icon";
import { Section, Segmented } from "./page";

export type Search = Record<string, string | undefined>;

const regions = new Intl.DisplayNames(["en"], { type: "region" });

/** 🇬🇧 United Kingdom, from GB. */
export function country(code: string | null | undefined): string {
  if (!code) return "Unknown";
  const flag = String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
  let name = code;
  try {
    name = regions.of(code) ?? code;
  } catch {
    // not a region code Intl knows
  }
  return `${flag} ${name}`;
}

export const capital = (s: string | null | undefined) => (s ? s[0]!.toUpperCase() + s.slice(1) : "Unknown");

export const LABELS: Record<Filter, string> = { page: "page", entry: "entry page", exit: "exit page", referrer: "source", utm_source: "UTM source", utm_medium: "UTM medium", utm_campaign: "UTM campaign", country: "country", device: "device", browser: "browser", os: "OS", screen: "screen" };

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** "+12% vs before", or nothing when there's nothing to compare with. */
export function change(now: number, before: number, lowerIsBetter = false): { text: string; good: boolean } | null {
  if (!before) return null;
  const pct = Math.round(((now - before) / before) * 100);
  if (!Number.isFinite(pct)) return null;
  return { text: `${pct > 0 ? "+" : ""}${pct}% vs before`, good: lowerIsBetter ? pct <= 0 : pct >= 0 };
}

/** 14:05 today, or Mon 3 Nov 14:05, in UTC as the charts are. */
export function when(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return new Date(now).toISOString().slice(0, 10) === d.toISOString().slice(0, 10) ? time : `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })} ${time}`;
}

/** Visitors an hour over a day, as small bars with each hour named on hover; empty hours are a line. */
export function Spark({ series, testId }: { series: { at: number; visitors: number }[]; testId?: string }) {
  const W = 168;
  const H = 28;
  const slot = W / Math.max(series.length, 1);
  const top = Math.max(1, ...series.map((p) => p.visitors));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Visitors an hour, the last 24 hours" className="block max-w-full" data-testid={testId}>
      {series.map((p, i) => {
        const h = p.visitors ? Math.max(2, (p.visitors / top) * H) : 1;
        return (
          <rect key={p.at} x={i * slot + 1} y={H - h} width={Math.max(1, slot - 2)} height={h} fill={p.visitors ? "var(--chart)" : "var(--border)"}>
            <title>{`${when(p.at)}: ${p.visitors.toLocaleString("en")} visitor${p.visitors === 1 ? "" : "s"}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

export const rangeOf = (sp: Search): Range => (RANGES.some(([r]) => r === sp.range) ? (sp.range as Range) : "7d");

export function filtersOf(sp: Search): Partial<Record<Filter, string>> {
  const out: Partial<Record<Filter, string>> = {};
  for (const f of FILTERS) if (sp[f] !== undefined) out[f] = sp[f];
  return out;
}

/** The same page with some query values changed (null drops one); 7 days is the default range. */
export function hrefWith(path: string, sp: Search, next: Record<string, string | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...sp, ...next })) if (v !== undefined && v !== null) p.set(k, v);
  if (p.get("range") === "7d") p.delete("range");
  const q = p.toString();
  return q ? `${path}?${q}` : path;
}

/** The range picker, and the filters in use with × to drop each. */
export function Controls({ path, sp, keep = [], children }: { path: string; sp: Search; keep?: string[]; children?: ReactNode }) {
  const range = rangeOf(sp);
  const filters = filtersOf(sp);
  // A new range or filter starts the page's own state (a page of a list, an open visit) over, except what it keeps.
  const base: Search = Object.fromEntries(Object.entries(sp).filter(([k]) => k === "range" || (FILTERS as readonly string[]).includes(k) || keep.includes(k)));
  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5">
        {children}
        <Segmented className="sm:ml-auto" items={RANGES.map(([r, label]) => ({ href: hrefWith(path, base, { range: r }), label, active: range === r }))} />
      </div>
      {Object.keys(filters).length > 0 && (
        <div className="flex flex-wrap items-center gap-2" data-testid="filters">
          <span className="text-[12px] text-muted">Only:</span>
          {Object.entries(filters).map(([f, v]) => (
            <Link key={f} href={hrefWith(path, base, { [f]: null })} className="inline-flex items-center gap-1.5 border border-border bg-card px-2 py-0.5 text-[12px] hover:bg-hover" title="Remove this filter">
              {LABELS[f as Filter]}: <b className="font-medium">{f === "country" ? country(v) : v || "none"}</b>
              <Icon icon={XIcon} size={12} />
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

/** A card of rows, each a share bar with visitors and a second count; a row filters the page by it. */
export function Breakdown({
  title,
  tabs,
  rows,
  name = (s) => s || "Unknown",
  countLabel,
  filterHref,
  more,
  testId,
}: {
  title: string;
  tabs?: { label: string; href: string; active: boolean }[];
  rows: Row[];
  name?: (s: string) => string;
  countLabel: string;
  /** Where a row's name leads: the page filtered by it. */
  filterHref?: (value: string) => string;
  /** A link to all of them. */
  more?: { href: string; label: string };
  testId?: string;
}) {
  const top = Math.max(0, ...rows.map((r) => r.visitors));
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
              {filterHref ? (
                <Link href={filterHref(r.name)} className="hover:underline" title={`Show only ${name(r.name)}`}>
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
        {(rows.length > 9 || more) && (
          <span className="pt-1.5 text-[12px] text-dim">
            {more ? (
              <Link href={more.href} className="text-accent hover:underline">
                {more.label}
              </Link>
            ) : (
              `and ${rows.length - 9} more`
            )}
          </span>
        )}
      </div>
    </Section>
  );
}

/** How a source reads: the referring site, else the UTM source, else direct. */
export const sourceOf = (v: { referrer: string | null; utmSource: string | null }) => v.referrer ?? (v.utmSource ? `${v.utmSource} (UTM)` : "Direct or unknown");

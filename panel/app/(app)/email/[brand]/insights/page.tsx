import type { ReactNode } from "react";
import { CARD, Empty, KeyValues, Notice, PageHeader, Section } from "@/components/page";
import { cx } from "@/components/ui";
import { brandFor, checkLabel, countryName, insightsOf, type Insights } from "@/lib/email";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Insights" };

const n = (v: number) => v.toLocaleString("en");
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : "0%");

/** One horizontal bar per row: the label, a bar against the biggest, the count and its share. */
function Bars({ rows, total, testId }: { rows: { label: ReactNode; value: number }[]; total: number; testId?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <Empty>Nothing yet.</Empty>;
  return (
    <div className="grid gap-1.5 px-3.5 py-3" data-testid={testId}>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[minmax(110px,180px)_minmax(0,1fr)_96px] items-center gap-3 text-[13px]">
          <span className="truncate">{r.label}</span>
          <span className="h-2 bg-field">
            <span className="block h-full bg-accent" style={{ width: `${Math.max(1, (r.value / max) * 100)}%` }} />
          </span>
          <span className="text-right tabular-nums text-muted">
            {n(r.value)} <span className="text-dim">· {pct(r.value, total)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Thin vertical bars, one per item, with a label under every few. */
function Columns({ values, labels, title, every = 1 }: { values: number[]; labels: string[]; title: (i: number) => string; every?: number }) {
  const max = Math.max(1, ...values);
  return (
    <div className="px-3.5 py-3">
      <div className="flex h-[120px] items-end gap-[3px]" role="img" aria-label={values.map((v, i) => `${labels[i]}: ${v}`).join(", ")}>
        {values.map((v, i) => (
          <span key={i} className="flex h-full flex-1 items-end" title={title(i)}>
            <span className={cx("block w-full", v ? "bg-accent" : "bg-field")} style={{ height: `${v ? Math.max(3, (v / max) * 100) : 3}%` }} />
          </span>
        ))}
      </div>
      <div className="mt-1.5 flex gap-[3px] text-[11px] text-dim">
        {labels.map((l, i) => (
          <span key={i} className="flex-1 truncate text-center">
            {i % every === 0 ? l : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

const SOURCES: [keyof Insights["growth"][number], string][] = [
  ["form", "Sign-up forms"],
  ["sync", "Synced from your apps"],
  ["api", "The API"],
  ["import", "Imports"],
  ["panel", "Added by hand"],
  ["event", "API events"],
  ["other", "Other"],
];

export default async function InsightsPage({ params }: { params: Promise<{ brand: string }> }) {
  await requireUser();
  const ctx = await brandFor((await params).brand);
  if (!ctx) return null;
  const { project, brand } = ctx;
  let i: Insights;
  try {
    i = await insightsOf(project, brand.id);
  } catch (err) {
    return (
      <>
        <PageHeader title={brand.name} crumb="Insights" />
        <Notice lead="Not reachable" tone="err">
          {(err as Error).message}
        </Notice>
      </>
    );
  }
  const e = i.engagement;
  const subscribed = e.active + e.cooling + e.inactive + e.none;
  const weekTotals = i.growth.map((w) => SOURCES.reduce((sum, [k]) => sum + (w[k] as number), 0));
  const bySource = SOURCES.map(([k, label]) => ({ label, value: i.growth.reduce((sum, w) => sum + (w[k] as number), 0) })).filter((r) => r.value > 0);
  const grown = weekTotals.reduce((a, b) => a + b, 0);
  const best = i.hours.indexOf(Math.max(...i.hours));
  const h = (x: number) => `${String(x).padStart(2, "0")}:00`;
  const health = i.health;
  return (
    <>
      <PageHeader title={brand.name} crumb="Insights" meta={`${n(i.contacts)} subscribed and unconfirmed contacts`} />
      <Section title="Engagement" description="Subscribed contacts by their last open or click. Apple's automatic opens don't count.">
        <Bars
          testId="insights-engagement"
          total={subscribed}
          rows={[
            { label: "Active, 30 days", value: e.active },
            { label: "Cooling, 30–90 days", value: e.cooling },
            { label: "Inactive, 90+ days", value: e.inactive },
            { label: "No opens yet", value: e.none },
          ]}
        />
      </Section>
      <div className="grid gap-3.5 lg:grid-cols-2">
        <Section title="Countries" description="From sign-ups and clicks; opens through mail proxies can't tell.">
          <Bars testId="insights-countries" total={i.contacts} rows={i.countries.slice(0, 12).map((c) => ({ label: c.k ? countryName(c.k) : <span className="text-muted">Not known yet</span>, value: c.n }))} />
        </Section>
        <Section title="Devices and email apps" description="From the reader's own device: sign-ups, clicks and opens not through a proxy.">
          <Bars total={i.contacts} rows={i.devices.map((d) => ({ label: d.k ? `${d.k[0]!.toUpperCase()}${d.k.slice(1)}` : <span className="text-muted">Not known yet</span>, value: d.n }))} />
          <div className="border-t border-border" />
          <Bars total={i.contacts} rows={i.clients.filter((c) => c.k).map((c) => ({ label: c.k, value: c.n }))} />
        </Section>
      </div>
      <Section
        title="Best hour to send"
        description={
          i.clicks.total
            ? `${n(i.clicks.total)} clicks in 90 days, by the hour in each contact's own time zone (${pct(i.clicks.withZone, i.clicks.total)} have one; the rest count in UTC). Most clicks come around ${h(best)}.`
            : "Shows once your emails get clicks: the hour they happen, in each contact's own time zone."
        }
      >
        {i.clicks.total > 0 && <Columns values={i.hours} labels={i.hours.map((_, x) => h(x))} every={3} title={(x) => `${h(x)}: ${n(i.hours[x]!)} clicks`} />}
      </Section>
      <div className="grid gap-3.5 lg:grid-cols-2">
        <Section title="New contacts" description={`${n(grown)} in the last 12 weeks, by week and where they came from.`}>
          <Columns values={weekTotals} labels={i.growth.map((w) => new Date(w.at).toLocaleDateString("en", { month: "short", day: "numeric" }))} every={3} title={(x) => `Week of ${new Date(i.growth[x]!.at).toLocaleDateString("en", { month: "short", day: "numeric" })}: ${n(weekTotals[x]!)}`} />
          <div className="border-t border-border" />
          <Bars total={grown} rows={bySource} />
        </Section>
        <section className={CARD}>
          <div className="px-3.5 pt-3.5">
            <h2 className="text-[14px] font-bold">List health</h2>
            <p className="text-[12px] text-muted">The last 30 days. Mailbox providers start filtering above 2% bounces or 0.1% complaints.</p>
          </div>
          <KeyValues
            inset
            items={[
              ["Bounces", <span key="b" className={health.sent30d && health.bounced30d / health.sent30d > 0.02 ? "text-err" : ""}>{`${n(health.bounced30d)} of ${n(health.sent30d)} sent (${pct(health.bounced30d, health.sent30d)})`}</span>],
              ["Spam complaints", <span key="c" className={health.sent30d && health.complained30d / health.sent30d > 0.001 ? "text-err" : ""}>{`${n(health.complained30d)} (${pct(health.complained30d, health.sent30d)})`}</span>],
              ["Flagged by Shield", `${n(health.flagged)} waiting for approval (${pct(health.flagged, i.contacts)})`],
              ["Refused by Shield", health.shield.refused ? `${n(health.shield.refused)}: ${Object.entries(health.shield.byCheck).filter(([, v]) => v!.refused).map(([k, v]) => `${checkLabel(k)} ${n(v!.refused)}`).join(", ")}` : "None"],
            ]}
          />
        </section>
      </div>
    </>
  );
}

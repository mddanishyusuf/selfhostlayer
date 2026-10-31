import { CircleDollarSignIcon } from "lucide-react";
import Link from "next/link";
import { SyncNowButton } from "@/components/analytics-forms";
import { change, Controls, country, filtersOf, hrefWith, rangeOf, sourceOf, when, type Search } from "@/components/analytics-ui";
import { BarChart } from "@/components/bar-chart";
import { Icon } from "@/components/icon";
import { CARD, Notice, PageHeader, PillLink, Section, Segmented, Stats, TileIcon } from "@/components/page";
import { Pill } from "@/components/ui";
import { PROVIDERS, revenueOf, siteFor, type Revenue, type RevenueRow } from "@/lib/analytics";
import { money } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Revenue" };

const providerName = (id: string) => PROVIDERS.find((p) => p.id === id)?.name ?? id;

/** Rows of revenue by a visit's field, with what visitors that way were worth each. */
function RevenueCard({ title, tabs, rows, currency, name, filterHref }: { title: string; tabs?: { label: string; href: string; active: boolean }[]; rows: RevenueRow[]; currency: string; name: (s: string) => string; filterHref: (v: string) => string }) {
  const top = rows[0]?.amount ?? 0;
  return (
    <Section title={title} aside={tabs && <Segmented items={tabs} />}>
      <div className="grid border-t border-border px-3.5 py-2.5">
        <div className="grid grid-cols-[minmax(0,1fr)_84px_56px_76px] gap-3 pb-1.5 text-[12px] text-dim">
          <span />
          <span className="text-right">Revenue</span>
          <span className="text-right">Paid</span>
          <span className="text-right" title="Revenue for each visitor who came that way">
            Per visitor
          </span>
        </div>
        {rows.length === 0 && <span className="py-2 text-[12px] text-dim">No payment credited to a visit yet.</span>}
        {rows.slice(0, 9).map((r) => (
          <div key={r.name} className="relative grid grid-cols-[minmax(0,1fr)_84px_56px_76px] items-center gap-3 py-1.5 text-[13px]">
            <span className="absolute inset-y-[3px] left-0 max-w-[calc(100%-240px)] bg-track" style={{ width: `${top ? Math.max(1, (r.amount / top) * 100) : 0}%` }} aria-hidden />
            <Link href={filterHref(r.name)} className="relative truncate pl-2 hover:underline" title={`Show only ${name(r.name)}`}>
              {name(r.name)}
            </Link>
            <span className="relative text-right font-bold tabular-nums">{money(r.amount, currency)}</span>
            <span className="relative text-right tabular-nums text-muted">{r.payments}</span>
            <span className="relative text-right tabular-nums text-muted">{r.visitors ? money(Math.round(r.amount / r.visitors), currency) : "–"}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

export default async function RevenuePage({ params, searchParams }: { params: Promise<{ site: string }>; searchParams: Promise<Search & { by?: string }> }) {
  const ctx = await siteFor((await params).site);
  if (!ctx) return null;
  const { project, site } = ctx;
  const sp = await searchParams;
  const path = `/analytics/${site.domain}/revenue`;
  const settings = `/analytics/${site.domain}/settings#revenue`;
  let r: Revenue | null = null;
  let problem: string | null = null;
  try {
    r = await revenueOf(project, site.id, rangeOf(sp), filtersOf(sp));
  } catch (err) {
    problem = (err as Error).message;
  }
  const failing = r?.sources.filter((s) => s.error) ?? [];
  const synced = r?.sources.map((s) => s.syncedAt ?? 0).reduce((a, b) => Math.max(a, b), 0) ?? 0;
  const filterHref = (f: string) => (v: string) => hrefWith(`/analytics/${site.domain}/revenue`, sp, { [f]: v });

  if (r && r.sources.length === 0 && !r.currency) {
    return (
      <>
        <PageHeader title={site.domain} crumb="Revenue" meta="What each source brings in" />
        <section className={`${CARD} grid justify-items-center gap-3 px-6 py-12 text-center`} data-testid="revenue-setup">
          <TileIcon tone="teal">
            <Icon icon={CircleDollarSignIcon} size={20} />
          </TileIcon>
          <p className="text-[17px] font-bold">See which sources bring paying customers</p>
          <p className="max-w-[560px] text-muted">
            Connect Stripe, Polar or Dodo Payments with a key that can read payments. Each payment whose checkout carries the visit (<code className="font-mono text-[12.5px]">shl_visit</code>, from <code className="font-mono text-[12.5px]">window.shl.visit</code>) is
            credited to where that visit came from, its campaign, its first page and its country. No cookies, and nothing about the customer but their id.
          </p>
          <PillLink href={settings} primary>
            Connect a provider
          </PillLink>
        </section>
      </>
    );
  }

  const t = r?.total;
  const sources = sp.by === "utm_source" ? r?.utmSources : sp.by === "utm_campaign" ? r?.utmCampaigns : r?.referrers;
  return (
    <>
      <PageHeader
        title={site.domain}
        crumb="Revenue"
        meta={r?.sources.length ? `From ${r.sources.map((s) => providerName(s.provider)).join(", ")}${synced ? `, synced ${when(synced)} UTC` : ", syncing…"}` : "What each source brings in"}
        actions={r && r.sources.length > 0 && <SyncNowButton site={site.id} />}
      />
      <Controls path={path} sp={sp} keep={["by"]} />
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      {failing.map((s) => (
        <Notice key={s.provider} lead={`${providerName(s.provider)} failed`} tone="err">
          {s.error}{" "}
          <Link href={settings} className="underline">
            Check its key
          </Link>
        </Notice>
      ))}
      {r && t && r.currency && (
        <>
          <Stats
            items={[
              { label: "Revenue", value: money(t.amount, r.currency), detail: change(t.amount, r.previous.amount)?.text ?? "Without tax, before fees" },
              { label: "Payments", value: t.payments.toLocaleString("en"), detail: `${t.customers.toLocaleString("en")} customer${t.customers === 1 ? "" : "s"}` },
              { label: "Revenue per visitor", value: money(r.visitors ? Math.round(t.amount / r.visitors) : 0, r.currency), detail: `${r.visitors.toLocaleString("en")} visitors` },
              { label: "Credited to a visit", value: `${t.amount ? Math.round((t.attributed / t.amount) * 100) : 0}%`, detail: `${money(t.amount - t.attributed, r.currency)} unattributed` },
              { label: "Renewals", value: money(t.renewals, r.currency), detail: "Credited to the first visit" },
            ]}
          />
          {r.others.length > 0 && (
            <p className="text-[12px] text-muted">
              In {r.currency.toUpperCase()}, the currency of most payments. Also: {r.others.map((o) => `${money(o.amount, o.currency)} (${o.payments})`).join(", ")}, not in these numbers.
            </p>
          )}
          <Section title="Revenue" description={r.bucket === "hour" ? "By the hour, in UTC" : "By the day, in UTC"}>
            <div className="border-t border-border px-3.5 pt-5">
              <BarChart points={r.series.map((s) => ({ at: s.at, value: s.amount, detail: `${s.payments} payment${s.payments === 1 ? "" : "s"}` }))} bucket={r.bucket} noun={["payment", "payments"]} currency={r.currency} testId="revenue-chart" />
            </div>
          </Section>
          <div className="grid gap-3.5 lg:grid-cols-2">
            <RevenueCard
              title="Sources"
              tabs={[
                { label: "Sites", href: hrefWith(path, sp, { by: null }), active: !sp.by || sp.by === "referrer" },
                { label: "UTM source", href: hrefWith(path, sp, { by: "utm_source" }), active: sp.by === "utm_source" },
                { label: "Campaign", href: hrefWith(path, sp, { by: "utm_campaign" }), active: sp.by === "utm_campaign" },
              ]}
              rows={sources ?? []}
              currency={r.currency}
              name={(s) => s || (sp.by ? "None" : "Direct or unknown")}
              filterHref={filterHref(sp.by === "utm_source" ? "utm_source" : sp.by === "utm_campaign" ? "utm_campaign" : "referrer")}
            />
            <RevenueCard title="First pages" rows={r.entries} currency={r.currency} name={(s) => s || "Unknown"} filterHref={filterHref("entry")} />
            <RevenueCard title="Countries" rows={r.countries} currency={r.currency} name={country} filterHref={filterHref("country")} />
            <Section title="Latest payments">
              <div className="border-t border-border" data-testid="payments">
                {r.latest.length === 0 && <p className="px-3.5 py-4 text-[12px] text-dim">No payments in this range.</p>}
                {r.latest.slice(0, 12).map((p) => (
                  <div key={`${p.provider}:${p.id}`} className="grid grid-cols-[86px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border-soft px-3.5 py-2 text-[13px] last:border-b-0">
                    <b className="font-bold tabular-nums">{money(p.amount, p.currency)}</b>
                    <span className="min-w-0 truncate text-muted">
                      {p.visit ? (
                        <Link href={`/analytics/${site.domain}/users?visit=${encodeURIComponent(p.visit)}`} className="text-foreground hover:underline">
                          {sourceOf({ referrer: p.referrer, utmSource: p.utmSource })}
                        </Link>
                      ) : (
                        "Unattributed"
                      )}
                      {p.visit && p.entry && <> · {p.entry}</>}
                    </span>
                    <span className="flex items-center gap-1.5 whitespace-nowrap text-[12px] text-muted">
                      {p.renewal && <Pill outline>Renewal</Pill>}
                      {providerName(p.provider)} · {when(p.at)}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          </div>
        </>
      )}
      {r && !r.currency && (
        <Notice lead="No payments yet" tone="lav">
          {r.sources.some((s) => s.syncing || !s.syncedAt) ? "The first sync is still running." : "None in the last 90 days, or none that took money."} Payments come in every 10 minutes.
        </Notice>
      )}
    </>
  );
}

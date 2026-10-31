import Link from "next/link";
import { BarChart } from "@/components/bar-chart";
import { pct, SetupChecklist, StatusPill, when } from "@/components/email-ui";
import { CARD, Empty, Notice, PageHeader, Section, Stats } from "@/components/page";
import { brandFor, listsOf, overviewOf, setupSteps, type Overview } from "@/lib/email";

export const dynamic = "force-dynamic";
export const metadata = { title: "Email" };

export default async function OverviewPage({ params }: { params: Promise<{ brand: string }> }) {
  const ctx = await brandFor((await params).brand);
  if (!ctx) return null;
  const { project, brand } = ctx;
  let o: Overview | null = null;
  let lists = 0;
  let problem: string | null = null;
  try {
    const [ov, l] = await Promise.all([overviewOf(project, brand.id, 30), listsOf(project, brand.id)]);
    o = ov;
    lists = l.length;
  } catch (err) {
    problem = (err as Error).message;
  }
  const t = o?.stats.total;
  return (
    <>
      <PageHeader title={brand.name} meta="Overview: the last 30 days" />
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      {o && t && (
        <>
          <SetupChecklist steps={setupSteps({ brand: o.brand, domains: o.domains, lists })} />
          <Stats
            items={[
              { label: "Sent", value: t.sent.toLocaleString("en"), detail: `${t.failed.toLocaleString("en")} failed` },
              { label: "Opened", value: pct(t.opened, t.sent), detail: `${t.opened.toLocaleString("en")} emails` },
              { label: "Clicked", value: pct(t.clicked, t.sent), detail: `${t.clicked.toLocaleString("en")} emails` },
              { label: "Bounced", value: pct(t.bounced, t.sent), detail: `${t.complained.toLocaleString("en")} marked as spam` },
              { label: "Subscribed", value: o.contacts.subscribed.toLocaleString("en"), detail: `${t.unsubscribed.toLocaleString("en")} left in 30 days` },
            ]}
          />
          <Section title="Sent" description="By the day, every kind of email">
            <div className="border-t border-border px-3.5 pt-5">
              <BarChart points={o.stats.series.map((d) => ({ at: d.at, value: d.sent, detail: `${d.opened} opened, ${d.clicked} clicked` }))} bucket="day" noun={["email", "emails"]} testId="sent-chart" />
            </div>
          </Section>
          <div className="grid gap-3.5 lg:grid-cols-2">
            <Section title="Contacts" aside={<Link href={`/email/${brand.id}/contacts`} className="text-[12px] text-accent hover:underline">All contacts</Link>}>
              <div className="border-t border-border">
                {(["subscribed", "unconfirmed", "unsubscribed", "bounced", "complained"] as const).map((s) => (
                  <Link key={s} href={`/email/${brand.id}/contacts?status=${s}`} className="flex items-center justify-between border-b border-border-soft px-3.5 py-2 text-[13px] last:border-b-0 hover:bg-hover">
                    <StatusPill status={s} />
                    <span className="tabular-nums">{o!.contacts[s].toLocaleString("en")}</span>
                  </Link>
                ))}
              </div>
            </Section>
            <Section title="Campaigns" aside={<Link href={`/email/${brand.id}/campaigns`} className="text-[12px] text-accent hover:underline">All campaigns</Link>}>
              <div className="border-t border-border">
                {o.campaigns.length === 0 && <Empty>No campaigns yet.</Empty>}
                {o.campaigns.map((c) => (
                  <Link key={c.id} href={`/email/${brand.id}/campaigns/${c.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border-soft px-3.5 py-2 text-[13px] last:border-b-0 hover:bg-hover">
                    <span className="grid min-w-0">
                      <span className="truncate font-bold">{c.name}</span>
                      <span className="truncate text-[12px] text-muted">
                        {c.stats.sent ? `${c.stats.sent.toLocaleString("en")} sent · ${pct(c.stats.opened, c.stats.sent)} opened · ${pct(c.stats.clicked, c.stats.sent)} clicked` : when(c.scheduledAt ?? c.updatedAt)}
                      </span>
                    </span>
                    <StatusPill status={c.status} />
                  </Link>
                ))}
              </div>
            </Section>
          </div>
          <section className={`${CARD} px-3.5 py-3 text-[12px] text-muted`}>
            Opens are counted from an image, so they&apos;re a rough measure: Apple Mail loads images for everyone (more opens), and other apps block them (fewer). Clicks are the better signal.
          </section>
        </>
      )}
    </>
  );
}

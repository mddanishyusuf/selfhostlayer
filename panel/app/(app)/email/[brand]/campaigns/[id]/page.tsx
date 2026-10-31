import { notFound } from "next/navigation";
import { CampaignButtons, CampaignEditor } from "@/components/email-forms";
import { pct, StatusPill, when } from "@/components/email-ui";
import { CARD, KeyValues, Notice, PageHeader, Section, Stats } from "@/components/page";
import { RefreshEvery } from "@/components/refresh";
import { brandFor, campaignOf, EmailError, listsOf, type List } from "@/lib/email";
import { sampleMerge } from "@/lib/markdown";

export const dynamic = "force-dynamic";
export const metadata = { title: "Campaign" };

export default async function CampaignPage({ params }: { params: Promise<{ brand: string; id: string }> }) {
  const { brand: brandParam, id } = await params;
  const ctx = await brandFor(brandParam);
  if (!ctx) return null;
  const { project, brand } = ctx;
  let data: Awaited<ReturnType<typeof campaignOf>>;
  let lists: List[];
  try {
    [data, lists] = await Promise.all([campaignOf(project, brand.id, Number(id)), listsOf(project, brand.id)]);
  } catch (err) {
    if (err instanceof EmailError && err.status === 404) notFound();
    return (
      <Notice lead="Not reachable" tone="err">
        {(err as Error).message}
      </Notice>
    );
  }
  const { campaign: c, links, audience, problems } = data;
  const editable = c.status === "draft" || c.status === "scheduled";
  const listName = (ids: number[]) => ids.map((i) => lists.find((l) => l.id === i)?.name ?? `#${i}`).join(", ") || "None";
  const s = c.stats;
  const sent = s.sent + s.bounced + s.failed;
  return (
    <>
      {(c.status === "sending" || c.status === "scheduled") && <RefreshEvery seconds={5} />}
      <PageHeader title={brand.name} crumb={c.name} meta={<span className="inline-flex items-center gap-2"><StatusPill status={c.status} testId="campaign-status" />{c.status === "scheduled" ? `Goes out ${when(c.scheduledAt)}` : c.startedAt ? `Started ${when(c.startedAt)}` : "Draft"}</span>} actions={<CampaignButtons brandId={brand.id} campaign={c} />} />
      {c.pausedReason && (
        <Notice lead="Paused" tone="gold">
          {c.pausedReason}
        </Notice>
      )}
      {editable ? (
        <>
          {problems.length > 0 && (
            <Notice lead="Not ready to send" tone="gold">
              {problems.join("; ")}.
            </Notice>
          )}
          <p className="text-[12px] text-muted">Goes to {audience.toLocaleString("en")} subscribed contact{audience === 1 ? "" : "s"} now (saved lists; the suppression list is left out).</p>
          <CampaignEditor brand={brand} campaign={c} lists={lists} audience={audience} />
        </>
      ) : (
        <>
          <Stats
            items={[
              { label: "Sent", value: sent.toLocaleString("en"), detail: s.queued ? `${s.queued.toLocaleString("en")} still to go` : `of ${s.recipients.toLocaleString("en")}` },
              { label: "Opened", value: pct(s.opened, sent), detail: `${s.opened.toLocaleString("en")} people` },
              { label: "Clicked", value: pct(s.clicked, sent), detail: `${s.clicked.toLocaleString("en")} people` },
              { label: "Bounced", value: pct(s.bounced, sent), detail: `${s.failed.toLocaleString("en")} failed` },
              { label: "Unsubscribed", value: pct(s.unsubscribed, sent), detail: `${s.complained.toLocaleString("en")} marked as spam` },
            ]}
          />
          <div className="grid gap-3.5 lg:grid-cols-2">
            <Section title="Links clicked">
              <div className="border-t border-border" data-testid="campaign-links">
                {links.length > 0 && (
                  <div className="grid grid-cols-[minmax(0,1fr)_64px_64px] gap-3 px-3.5 pt-2 text-[12px] text-dim">
                    <span />
                    <span className="text-right">People</span>
                    <span className="text-right">Clicks</span>
                  </div>
                )}
                {links.length === 0 && <p className="px-3.5 py-4 text-[12px] text-dim">No clicks yet.</p>}
                {links.map((l) => (
                  <div key={l.url} className="grid grid-cols-[minmax(0,1fr)_64px_64px] gap-3 border-b border-border-soft px-3.5 py-2 text-[13px] last:border-b-0">
                    <a href={l.url} target="_blank" rel="noreferrer noopener" className="truncate hover:underline">
                      {l.url.replace(/^https?:\/\//, "")}
                    </a>
                    <span className="text-right tabular-nums">{l.people}</span>
                    <span className="text-right tabular-nums text-muted">{l.clicks}</span>
                  </div>
                ))}
              </div>
            </Section>
            <Section title="What went out">
              <KeyValues
                items={[
                  ["Subject", c.subject],
                  ["From", c.fromName ? `${c.fromName} <${c.fromEmail}>` : c.fromEmail],
                  ["To", listName(c.lists)],
                  ["Left out", listName(c.excludeLists)],
                  ["Finished", c.finishedAt ? when(c.finishedAt) : "–"],
                ]}
              />
            </Section>
          </div>
          <section className={CARD}>
            <iframe title="The email" sandbox="" srcDoc={sampleMerge(c.html, brand.name)} className="h-[560px] w-full bg-white" />
          </section>
        </>
      )}
    </>
  );
}

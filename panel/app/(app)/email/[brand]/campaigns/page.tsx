import Link from "next/link";
import { NewCampaignButton } from "@/components/email-forms";
import { pct, StatusPill, when } from "@/components/email-ui";
import { CARD, Empty, Notice, PageHeader } from "@/components/page";
import { brandFor, campaignsOf, listsOf, type Campaign, type List } from "@/lib/email";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Campaigns" };

const GRID = "minmax(0,1fr) 96px 90px 80px 80px 130px";

export default async function CampaignsPage({ params }: { params: Promise<{ brand: string }> }) {
  await requireUser();
  const ctx = await brandFor((await params).brand);
  if (!ctx) return null;
  const { project, brand } = ctx;
  let campaigns: Campaign[] = [];
  let lists: List[] = [];
  let problem: string | null = null;
  try {
    [campaigns, lists] = await Promise.all([campaignsOf(project, brand.id), listsOf(project, brand.id)]);
  } catch (err) {
    problem = (err as Error).message;
  }
  return (
    <>
      <PageHeader title={brand.name} crumb="Campaigns" meta="One email to your lists" actions={<NewCampaignButton brandId={brand.id} lists={lists} />} />
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      <section className={CARD} data-testid="campaigns">
        <div className="hidden h-9 items-center gap-x-4 border-b border-border px-3.5 text-[12px] text-muted md:grid" style={{ gridTemplateColumns: GRID }}>
          <span>Campaign</span>
          <span>Status</span>
          <span className="text-right">Sent</span>
          <span className="text-right">Opened</span>
          <span className="text-right">Clicked</span>
          <span className="text-right">When</span>
        </div>
        {campaigns.length === 0 && !problem && <Empty>No campaigns yet: New campaign writes the first.</Empty>}
        {campaigns.map((c) => (
          <Link key={c.id} href={`/email/${brand.id}/campaigns/${c.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-soft px-3.5 py-2.5 text-[13px] last:border-b-0 hover:bg-hover md:grid" style={{ gridTemplateColumns: GRID }} data-testid="campaign-row">
            <span className="grid min-w-0 basis-full md:basis-auto">
              <b className="truncate font-bold">{c.name}</b>
              <span className="truncate text-[12px] text-muted">{c.subject || "No subject yet"}</span>
            </span>
            <span>
              <StatusPill status={c.status} />
            </span>
            <span className="text-right tabular-nums">{c.stats.sent ? c.stats.sent.toLocaleString("en") : "–"}</span>
            <span className="text-right tabular-nums text-muted">{pct(c.stats.opened, c.stats.sent)}</span>
            <span className="text-right tabular-nums text-muted">{pct(c.stats.clicked, c.stats.sent)}</span>
            <span className="text-right text-[12px] text-muted">{when(c.startedAt ?? c.scheduledAt ?? c.updatedAt)}</span>
          </Link>
        ))}
      </section>
    </>
  );
}

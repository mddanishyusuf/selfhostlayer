import Link from "next/link";
import { NewAutomationButton } from "@/components/email-forms";
import { StatusPill } from "@/components/email-ui";
import { CARD, Empty, Notice, PageHeader } from "@/components/page";
import { automationsOf, brandFor, listsOf, type Automation, type List } from "@/lib/email";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automations" };

export default async function AutomationsPage({ params }: { params: Promise<{ brand: string }> }) {
  const ctx = await brandFor((await params).brand);
  if (!ctx) return null;
  const { project, brand } = ctx;
  let automations: Automation[] = [];
  let lists: List[] = [];
  let problem: string | null = null;
  try {
    [automations, lists] = await Promise.all([automationsOf(project, brand.id), listsOf(project, brand.id)]);
  } catch (err) {
    problem = (err as Error).message;
  }
  return (
    <>
      <PageHeader title={brand.name} crumb="Automations" meta="Emails that go by themselves: a welcome series, a trial ending…" actions={<NewAutomationButton brandId={brand.id} lists={lists} />} />
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      <section className={CARD} data-testid="automations">
        {automations.length === 0 && !problem && <Empty>No automations yet. One starts when a contact joins a list, or when your app sends an event (POST /events).</Empty>}
        {automations.map((a) => (
          <Link key={a.id} href={`/email/${brand.id}/automations/${a.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border-soft px-3.5 py-2.5 text-[13px] last:border-b-0 hover:bg-hover">
            <span className="grid min-w-0">
              <b className="truncate font-bold">{a.name}</b>
              <span className="truncate text-[12px] text-muted">
                {a.trigger === "list" ? `When someone joins ${lists.find((l) => String(l.id) === a.triggerValue)?.name ?? "a list"}` : `On the event ${a.triggerValue}`} · {a.steps.length} step{a.steps.length === 1 ? "" : "s"} · {a.runs.active} running, {a.runs.done} done
              </span>
            </span>
            <StatusPill status={a.status} />
          </Link>
        ))}
      </section>
    </>
  );
}

import { notFound } from "next/navigation";
import { AutomationButtons, AutomationEditor } from "@/components/email-forms";
import { StatusPill, when } from "@/components/email-ui";
import { Empty, Notice, PageHeader, Section, Stats } from "@/components/page";
import { automationOf, brandFor, EmailError, listsOf, type List } from "@/lib/email";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automation" };

export default async function AutomationPage({ params }: { params: Promise<{ brand: string; id: string }> }) {
  const { brand: b, id } = await params;
  const ctx = await brandFor(b);
  if (!ctx) return null;
  const { project, brand } = ctx;
  let data: Awaited<ReturnType<typeof automationOf>>;
  let lists: List[];
  try {
    [data, lists] = await Promise.all([automationOf(project, brand.id, Number(id)), listsOf(project, brand.id)]);
  } catch (err) {
    if (err instanceof EmailError && err.status === 404) notFound();
    return (
      <Notice lead="Not reachable" tone="err">
        {(err as Error).message}
      </Notice>
    );
  }
  const a = data.automation;
  return (
    <>
      <PageHeader title={brand.name} crumb={a.name} back={`/email/${brand.id}/automations`} meta={<span className="inline-flex items-center gap-2"><StatusPill status={a.status} testId="automation-status" />{a.status === "active" ? "Runs start as contacts come" : "Turn it on to start runs"}</span>} actions={<AutomationButtons brandId={brand.id} automation={a} />} />
      <Stats
        items={[
          { label: "Running", value: a.runs.active.toLocaleString("en"), detail: "Waiting for their next step" },
          { label: "Done", value: a.runs.done.toLocaleString("en"), detail: "Went through every step" },
          { label: "Left", value: a.runs.exited.toLocaleString("en"), detail: "Unsubscribed or bounced" },
          { label: "Failed", value: a.runs.failed.toLocaleString("en"), detail: "A step couldn't run" },
        ]}
      />
      <AutomationEditor brand={brand} automation={a} lists={lists} />
      <Section title="Runs" description="Newest first: one per contact">
        <div className="border-t border-border" data-testid="automation-runs">
          {data.runs.length === 0 && <Empty>No runs yet.</Empty>}
          {data.runs.map((r) => (
            <div key={r.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border-soft px-3.5 py-2 text-[13px] last:border-b-0">
              <span className="grid min-w-0">
                <span className="truncate">{r.email}</span>
                <span className="truncate text-[12px] text-muted">
                  Started {when(r.startedAt)} · {r.status === "active" ? `step ${r.step + 1} at ${when(r.nextAt)}` : r.error ? r.error : `ended ${when(r.finishedAt)}`}
                </span>
              </span>
              <StatusPill status={r.status} />
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

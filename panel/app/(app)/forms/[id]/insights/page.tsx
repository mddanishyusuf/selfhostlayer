import { BarChart } from "@/components/bar-chart";
import { duration } from "@/components/forms-ui";
import { Empty, Notice, PageHeader, Section, Segmented, Stats } from "@/components/page";
import { FIELD_LABELS, formFor, insightsOf, type FieldType, type Insights } from "@/lib/forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Insights" };

const RANGES = [7, 30, 90];
const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 1000) / 10}%`);

/** One question's answers: a bar per choice, or the latest answers in words. */
function Question({ q, total }: { q: Insights["fields"][number]; total: number }) {
  const top = Math.max(1, ...(q.counts ?? []).map((c) => c.count));
  const summary = [
    `${q.answered.toLocaleString("en")} answered${total ? ` (${Math.round((q.answered / total) * 100)}%)` : ""}`,
    q.average !== undefined && q.average !== null ? `average ${q.average}` : null,
    q.nps !== undefined && q.nps !== null ? `NPS ${q.nps > 0 ? "+" : ""}${q.nps}` : null,
  ].filter(Boolean);
  return (
    <Section title={q.label} description={`${FIELD_LABELS[q.type as FieldType] ?? q.type} · ${summary.join(" · ")}`}>
      <div className="grid border-t border-border px-3.5 py-2.5" data-testid="question-insight">
        {q.counts &&
          q.counts.map((c) => (
            <div key={c.value} className="grid grid-cols-[minmax(0,1fr)_56px_56px] items-center gap-3 py-[3px] text-[13px]">
              {/* The bar spans the label's column only, so the longest is the column's width. */}
              <span className="relative min-w-0 py-[3px]">
                <span className="absolute inset-y-0 left-0 bg-track" style={{ width: `${c.count ? Math.max(1, (c.count / top) * 100) : 0}%` }} aria-hidden />
                <span className="relative block truncate pl-2">{q.type === "yes_no" ? (c.value === "yes" ? "Yes" : "No") : q.type === "rating" ? `${"★".repeat(Number(c.value))}` : c.value}</span>
              </span>
              <span className="text-right tabular-nums">{c.count.toLocaleString("en")}</span>
              <span className="text-right tabular-nums text-muted">{q.answered ? `${Math.round((c.count / q.answered) * 100)}%` : "–"}</span>
            </div>
          ))}
        {q.latest &&
          (q.latest.length ? (
            q.latest.map((a, i) => (
              <p key={i} className="whitespace-pre-wrap break-words border-b border-border-soft py-2 text-[13px] last:border-b-0">
                {a}
              </p>
            ))
          ) : (
            <span className="py-2 text-[12px] text-dim">No answers yet.</span>
          ))}
        {!q.counts && !q.latest && <span className="py-2 text-[12px] text-dim">Numbers only: the average is above.</span>}
      </div>
    </Section>
  );
}

/** How the form does: views, starts, responses and how long it takes, then each question's answers. */
export default async function InsightsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ days?: string }> }) {
  const ctx = await formFor((await params).id);
  if (!ctx) return null;
  const { project, form } = ctx;
  const days = RANGES.includes(Number((await searchParams).days)) ? Number((await searchParams).days) : 30;
  let data: Insights | null = null;
  let problem: string | null = null;
  try {
    data = await insightsOf(project, form.id, days);
  } catch (err) {
    problem = (err as Error).message;
  }
  const path = `/forms/${form.id}/insights`;
  return (
    <>
      <PageHeader title={form.title} crumb="Insights" meta="Who opened it, who finished, and what they said, since it was made" />
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      {data && (
        <>
          <Stats
            items={[
              { label: "Views", value: data.views.toLocaleString("en"), detail: "People who opened it" },
              { label: "Started", value: data.starts.toLocaleString("en"), detail: data.views ? `${pct(data.starts / data.views)} of views` : "Answered a question" },
              { label: "Responses", value: data.responses.toLocaleString("en"), detail: "Sent in, and kept" },
              { label: "Completion", value: pct(data.completion), detail: "Of those who started" },
              { label: "Time to fill in", value: duration(data.medianDuration), detail: "The median" },
            ]}
          />
          <Section title="Responses" description={`A day each, the last ${days} days (UTC)`} aside={<Segmented items={RANGES.map((d) => ({ label: `${d} days`, href: d === 30 ? path : `${path}?days=${d}`, active: d === days }))} />}>
            <div className="border-t border-border px-3.5 py-3">
              <BarChart points={data.series.map((d) => ({ at: d.at, value: d.responses }))} bucket="day" noun={["response", "responses"]} testId="responses-chart" />
            </div>
          </Section>
          {data.fields.length === 0 && (
            <Section>
              <Empty>The form has no questions yet.</Empty>
            </Section>
          )}
          {data.fields.map((q) => (
            <Question key={q.id} q={q} total={data.responses} />
          ))}
        </>
      )}
    </>
  );
}

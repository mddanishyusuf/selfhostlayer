import { DownloadIcon, SearchIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { CloseOnEscape } from "@/components/analytics-forms";
import { capital, country } from "@/components/analytics-ui";
import { when } from "@/components/email-ui";
import { DeleteAllResponses, DeleteResponseButton } from "@/components/forms-forms";
import { Answer, duration } from "@/components/forms-ui";
import { Icon } from "@/components/icon";
import { CARD, Empty, Notice, PageHeader } from "@/components/page";
import { NO_AUTOFILL, buttonClass } from "@/components/ui";
import { answerText, formFor, responseOf, responsesOf, type FormResponse } from "@/lib/forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Responses" };

type Search = { q?: string; page?: string; r?: string };
const ASKS = (t: string) => !["statement", "page_break"].includes(t);

/** Every response, newest first: the first questions as columns, the rest when one is opened. */
export default async function ResponsesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const ctx = await formFor((await params).id);
  if (!ctx) return null;
  const { project, form } = ctx;
  const sp = await searchParams;
  const path = `/forms/${form.id}/responses`;
  const href = (next: Partial<Search>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...next })) if (v) p.set(k, v);
    return p.size ? `${path}?${p}` : path;
  };
  let data: Awaited<ReturnType<typeof responsesOf>> | null = null;
  let open: FormResponse | null = null;
  let problem: string | null = null;
  try {
    data = await responsesOf(project, form.id, { q: sp.q, page: Number(sp.page) || 1 });
    if (sp.r) open = await responseOf(project, form.id, Number(sp.r)).catch(() => null);
  } catch (err) {
    problem = (err as Error).message;
  }
  const fields = form.schema.fields.filter((f) => ASKS(f.type));
  const columns = fields.filter((f) => f.type !== "hidden" && f.type !== "file").slice(0, 3);
  const grid = `${columns.map(() => "minmax(0,1fr)").join(" ")} 90px 130px`;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const fileHref = (file: string) => `/api/forms/${form.id}/files/${file}`;
  return (
    <>
      <PageHeader
        title={form.title}
        crumb="Responses"
        meta={data ? `${data.total.toLocaleString("en")} response${data.total === 1 ? "" : "s"}${sp.q ? ` with “${sp.q}”` : ""}` : "What people sent"}
        actions={
          <span className="flex flex-wrap gap-2">
            <a href={`/api/forms/${form.id}/export`} className={buttonClass("secondary", "sm")} data-testid="export-responses">
              <Icon icon={DownloadIcon} size={13} /> CSV
            </a>
            <DeleteAllResponses formId={form.id} count={form.responses} />
          </span>
        }
      />
      <form action={path} className="flex min-w-[200px] items-center gap-2 self-start border border-border bg-field px-2.5 sm:w-[320px]" role="search">
        <Icon icon={SearchIcon} size={14} className="text-muted" />
        <input name="q" defaultValue={sp.q} placeholder="Search the answers" className="h-[33px] min-w-0 flex-1 bg-transparent outline-none placeholder:text-placeholder" {...NO_AUTOFILL} />
      </form>
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      {data && (
        <section className={CARD} data-testid="responses">
          <div className="hidden h-9 items-center gap-x-4 border-b border-border px-3.5 text-[12px] text-muted md:grid" style={{ gridTemplateColumns: grid }}>
            {columns.map((f) => (
              <span key={f.id} className="truncate">
                {f.label || f.id}
              </span>
            ))}
            <span className="text-right">Took</span>
            <span className="text-right">Sent</span>
          </div>
          {data.responses.length === 0 && <Empty>{sp.q ? "No answers match." : "No responses yet: share the form from its Share page."}</Empty>}
          {data.responses.map((r) => (
            <Link key={r.id} href={href({ r: String(r.id) })} scroll={false} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-soft px-3.5 py-2.5 text-[13px] last:border-b-0 hover:bg-hover md:grid" style={{ gridTemplateColumns: grid }} data-testid="response-row">
              {columns.map((f, i) => (
                <span key={f.id} className={i === 0 ? "min-w-0 basis-full truncate font-medium md:basis-auto" : "min-w-0 truncate text-muted"}>
                  {answerText(r.answers[f.id]) || <span className="text-dim">–</span>}
                </span>
              ))}
              <span className="text-[12px] tabular-nums text-muted md:text-right">{duration(r.meta.duration)}</span>
              <span className="text-[12px] text-muted max-md:ml-auto md:text-right">{when(r.createdAt)}</span>
            </Link>
          ))}
          {pages > 1 && (
            <div className="flex items-center justify-between border-t border-border px-3.5 py-2.5 text-[12px] text-muted">
              <span>
                Page {data.page} of {pages}
              </span>
              <span className="flex gap-1.5">
                {data.page > 1 && (
                  <Link href={href({ page: String(data.page - 1), r: undefined })} className={buttonClass("secondary", "sm")}>
                    Previous
                  </Link>
                )}
                {data.page < pages && (
                  <Link href={href({ page: String(data.page + 1), r: undefined })} className={buttonClass("secondary", "sm")}>
                    Next
                  </Link>
                )}
              </span>
            </div>
          )}
        </section>
      )}
      {sp.r && (
        <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Response">
          <CloseOnEscape href={href({ r: undefined })} />
          <Link href={href({ r: undefined })} scroll={false} aria-label="Close" className="absolute inset-0 bg-black/40" />
          <aside className="absolute inset-y-0 right-0 flex w-[560px] max-w-full flex-col border-l border-border bg-card shadow-pop" data-testid="response-detail">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <h2 className="truncate text-[14px] font-bold">Response {open ? `#${open.id}` : ""}</h2>
                <p className="truncate text-[12px] text-muted">{open ? `${when(open.createdAt)} · took ${duration(open.meta.duration)}` : "It's gone: deleted, or never was"}</p>
              </div>
              <Link href={href({ r: undefined })} scroll={false} className="grid size-8 place-items-center text-muted hover:bg-hover hover:text-foreground" aria-label="Close">
                <Icon icon={XIcon} size={16} />
              </Link>
            </div>
            {open && (
              <div className="min-h-0 flex-1 overflow-y-auto">
                {fields.map((f) => (
                  <div key={f.id} className="grid gap-1 border-b border-border-soft px-4 py-3 text-[13px]">
                    <span className="text-[12px] text-muted">
                      {f.label || f.id}
                      {f.type === "hidden" && <span className="text-dim"> · from the link</span>}
                    </span>
                    <Answer field={f} response={open} fileHref={fileHref} />
                  </div>
                ))}
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 text-[12px]">
                  {(
                    [
                      ["Country", open.meta.country ? country(open.meta.country) : "–"],
                      ["Device", open.meta.device ? capital(open.meta.device) : "–"],
                      ["Browser", open.meta.browser ?? "–"],
                      ["Came from", open.meta.referrer ?? "Direct"],
                    ] as const
                  ).map(([k, v]) => (
                    <span key={k} className="grid">
                      <span className="text-muted">{k}</span>
                      <span className="truncate">{v}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {open && (
              <div className="flex justify-end border-t border-border px-4 py-3">
                <DeleteResponseButton formId={form.id} responseId={open.id} />
              </div>
            )}
          </aside>
        </div>
      )}
    </>
  );
}

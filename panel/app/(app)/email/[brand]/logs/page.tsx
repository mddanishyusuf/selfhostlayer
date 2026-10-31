import { SearchIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { CloseOnEscape } from "@/components/analytics-forms";
import { StatusPill, when } from "@/components/email-ui";
import { Icon } from "@/components/icon";
import { CARD, Empty, KeyValues, Notice, PageHeader, Segmented } from "@/components/page";
import { NO_AUTOFILL, buttonClass } from "@/components/ui";
import { brandFor, messageOf, messagesOf } from "@/lib/email";

export const dynamic = "force-dynamic";
export const metadata = { title: "Logs" };

type Search = { kind?: string; status?: string; q?: string; page?: string; m?: string };
const GRID = "minmax(0,1.2fr) minmax(0,1fr) 110px 100px 120px";
const KINDS: [string, string][] = [
  ["", "All"],
  ["transactional", "API"],
  ["campaign", "Campaigns"],
  ["automation", "Automations"],
  ["test", "Tests"],
];

export default async function LogsPage({ params, searchParams }: { params: Promise<{ brand: string }>; searchParams: Promise<Search> }) {
  const ctx = await brandFor((await params).brand);
  if (!ctx) return null;
  const { project, brand } = ctx;
  const sp = await searchParams;
  const path = `/email/${brand.id}/logs`;
  const href = (next: Partial<Search>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...next })) if (v) p.set(k, v);
    return p.size ? `${path}?${p}` : path;
  };
  let data: Awaited<ReturnType<typeof messagesOf>> | null = null;
  let problem: string | null = null;
  try {
    data = await messagesOf(project, brand.id, { kind: sp.kind, status: sp.status, q: sp.q, page: Number(sp.page) || 1 });
  } catch (err) {
    problem = (err as Error).message;
  }
  let detail: Awaited<ReturnType<typeof messageOf>> | null = null;
  if (sp.m) detail = await messageOf(project, brand.id, sp.m).catch(() => null);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <>
      <PageHeader title={brand.name} crumb="Logs" meta="Every email this brand sent or tried to, and what happened to it" />
      <div className="flex flex-wrap items-center gap-2.5">
        <Segmented items={KINDS.map(([k, label]) => ({ label, href: href({ kind: k || undefined, page: undefined, m: undefined }), active: (sp.kind ?? "") === k }))} />
        <form action={path} className="flex min-w-[200px] flex-1 items-center gap-2 border border-border bg-field px-2.5 sm:max-w-[300px]" role="search">
          {sp.kind && <input type="hidden" name="kind" value={sp.kind} />}
          <Icon icon={SearchIcon} size={14} className="text-muted" />
          <input name="q" defaultValue={sp.q} placeholder="Address, subject or id" className="h-[33px] min-w-0 flex-1 bg-transparent outline-none placeholder:text-placeholder" {...NO_AUTOFILL} />
        </form>
        <Segmented className="sm:ml-auto" items={[["", "Any"], ["sent", "Sent"], ["queued", "Queued"], ["bounced", "Bounced"], ["failed", "Failed"]].map(([s, label]) => ({ label: label!, href: href({ status: s || undefined, page: undefined, m: undefined }), active: (sp.status ?? "") === s }))} />
      </div>
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      {data && (
        <section className={CARD} data-testid="logs">
          <div className="hidden h-9 items-center gap-x-4 border-b border-border px-3.5 text-[12px] text-muted md:grid" style={{ gridTemplateColumns: GRID }}>
            <span>To</span>
            <span>Subject</span>
            <span>Kind</span>
            <span>Status</span>
            <span className="text-right">When</span>
          </div>
          {data.messages.length === 0 && <Empty>Nothing here yet.</Empty>}
          {data.messages.map((m) => (
            <Link key={m.id} href={href({ m: m.id })} scroll={false} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-soft px-3.5 py-2.5 text-[13px] last:border-b-0 hover:bg-hover md:grid" style={{ gridTemplateColumns: GRID }} data-testid="log-row">
              <span className="truncate font-bold">{m.to}</span>
              <span className="truncate text-muted">{m.subject}</span>
              <span className="text-[12px] text-muted">{m.kind === "transactional" ? "API" : m.kind[0]!.toUpperCase() + m.kind.slice(1)}</span>
              <span>
                <StatusPill status={m.clickedAt ? "clicked" : m.openedAt ? "opened" : m.status} />
              </span>
              <span className="text-right text-[12px] text-muted">{when(m.sentAt ?? m.createdAt)}</span>
            </Link>
          ))}
          {pages > 1 && (
            <div className="flex items-center justify-between border-t border-border px-3.5 py-2.5 text-[12px] text-muted">
              <span>
                Page {data.page} of {pages}
              </span>
              <span className="flex gap-1.5">
                {data.page > 1 && (
                  <Link href={href({ page: String(data.page - 1), m: undefined })} className={buttonClass("secondary", "sm")}>
                    Newer
                  </Link>
                )}
                {data.page < pages && (
                  <Link href={href({ page: String(data.page + 1), m: undefined })} className={buttonClass("secondary", "sm")}>
                    Older
                  </Link>
                )}
              </span>
            </div>
          )}
        </section>
      )}
      {sp.m && (
        <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Email">
          <CloseOnEscape href={href({ m: undefined })} />
          <Link href={href({ m: undefined })} scroll={false} aria-label="Close" className="absolute inset-0 bg-black/40" />
          <aside className="absolute inset-y-0 right-0 flex w-[560px] max-w-full flex-col border-l border-border bg-card shadow-pop" data-testid="log-detail">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <h2 className="truncate text-[14px] font-bold">{detail?.message.subject ?? "Email"}</h2>
                <p className="truncate text-[12px] text-muted">{detail ? `${detail.message.to_email} · ${when(detail.message.created_at)}` : "It's gone: older than the logs keep"}</p>
              </div>
              <Link href={href({ m: undefined })} scroll={false} className="grid size-8 place-items-center text-muted hover:bg-hover hover:text-foreground" aria-label="Close">
                <Icon icon={XIcon} size={16} />
              </Link>
            </div>
            {detail && (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <KeyValues
                  flush
                  items={[
                    ["Status", <StatusPill key="s" status={detail.message.status} />],
                    ["From", detail.payload?.from ?? detail.message.from_email],
                    ["To", (detail.payload?.to ?? [detail.message.to_email]).join(", ")],
                    ...(detail.payload?.cc?.length ? [["Cc", detail.payload.cc.join(", ")] as [string, string]] : []),
                    ...(detail.payload?.bcc?.length ? [["Bcc", detail.payload.bcc.join(", ")] as [string, string]] : []),
                    ["Id", <code key="id" className="font-mono text-[12px]">{detail.message.id}</code>],
                    ...(detail.message.error ? [["Why", <span key="e" className="text-rose">{detail.message.error}</span>] as [string, React.ReactNode]] : []),
                    ...(detail.payload?.attachments?.length ? [["Attached", detail.payload.attachments.map((a) => `${a.filename} (${Math.ceil(a.bytes / 1024)} KB)`).join(", ")] as [string, string]] : []),
                  ]}
                />
                <ol className="border-t border-border px-4 py-3">
                  {detail.events.map((e, i) => (
                    <li key={i} className="grid grid-cols-[120px_minmax(0,1fr)] gap-2 py-1 text-[13px]">
                      <span className="text-[12px] tabular-nums text-dim">{when(e.at)}</span>
                      <span className="min-w-0 break-words">
                        <b className="font-medium">{e.kind}</b>
                        {e.detail ? <span className="text-muted"> · {e.detail}</span> : null}
                      </span>
                    </li>
                  ))}
                </ol>
                {detail.payload?.html ? (
                  <iframe title="What it said" sandbox="" srcDoc={detail.payload.html} className="h-[480px] w-full border-t border-border bg-white" />
                ) : detail.payload?.text ? (
                  <pre className="whitespace-pre-wrap border-t border-border px-4 py-3 font-mono text-[12px]">{detail.payload.text}</pre>
                ) : (
                  <p className="border-t border-border px-4 py-3 text-[12px] text-muted">{detail.message.kind === "campaign" ? "Campaign emails are made from the campaign: its page shows what went out." : "Its body is past the time bodies are kept."}</p>
                )}
              </div>
            )}
          </aside>
        </div>
      )}
    </>
  );
}

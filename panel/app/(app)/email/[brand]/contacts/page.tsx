import { DownloadIcon } from "lucide-react";
import Link from "next/link";
import { ContactButtons, SuppressForm, UnsuppressButton } from "@/components/email-forms";
import { ContactFilters } from "@/components/email-filters";
import { StatusPill, when } from "@/components/email-ui";
import { Icon } from "@/components/icon";
import { CARD, Empty, Notice, PageHeader, Section, Segmented } from "@/components/page";
import { buttonClass } from "@/components/ui";
import { brandFor, checkLabel, contactsOf, listsOf, suppressionsOf, type List } from "@/lib/email";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Contacts" };

type Search = { q?: string; list?: string; status?: string; page?: string; view?: string };
const GRID = "minmax(0,1.4fr) minmax(0,1fr) 110px 120px";

export default async function ContactsPage({ params, searchParams }: { params: Promise<{ brand: string }>; searchParams: Promise<Search> }) {
  await requireUser();
  const ctx = await brandFor((await params).brand);
  if (!ctx) return null;
  const { project, brand } = ctx;
  const sp = await searchParams;
  const path = `/email/${brand.id}/contacts`;
  const href = (next: Partial<Search>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, page: undefined, ...next })) if (v) p.set(k, v);
    return p.size ? `${path}?${p}` : path;
  };
  let lists: List[] = [];
  let problem: string | null = null;
  let data: Awaited<ReturnType<typeof contactsOf>> | null = null;
  let suppressed: Awaited<ReturnType<typeof suppressionsOf>> | null = null;
  try {
    lists = await listsOf(project, brand.id);
    if (sp.view === "suppressed") suppressed = await suppressionsOf(project, brand.id, Number(sp.page) || 1);
    else data = await contactsOf(project, brand.id, { q: sp.q, list: sp.list, status: sp.status, page: Number(sp.page) || 1 });
  } catch (err) {
    problem = (err as Error).message;
  }
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const exportHref = `/api/email/${brand.id}/export?${new URLSearchParams(Object.entries({ list: sp.list ?? "", status: sp.status ?? "" }).filter(([, v]) => v))}`;
  return (
    <>
      <PageHeader title={brand.name} crumb="Contacts" meta={data ? `${data.total.toLocaleString("en")} contact${data.total === 1 ? "" : "s"}` : "Who you email"} actions={<ContactButtons brandId={brand.id} lists={lists} />} />
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <Segmented
          items={[
            { label: "Contacts", href: href({ view: undefined }), active: sp.view !== "suppressed" },
            { label: "Suppressed", href: href({ view: "suppressed", q: undefined, list: undefined, status: undefined }), active: sp.view === "suppressed" },
          ]}
        />
        {sp.view !== "suppressed" && (
          <a href={exportHref} className={buttonClass("secondary", "sm")} data-testid="export-contacts" title="Download the contacts shown as CSV">
            <Icon icon={DownloadIcon} size={13} /> Export CSV
          </a>
        )}
      </div>
      {sp.view !== "suppressed" && <ContactFilters path={path} q={sp.q} list={sp.list} status={sp.status} lists={lists.map((l) => ({ id: l.id, name: l.name, total: l.total }))} />}
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      {data && (
        <section className={CARD} data-testid="contacts">
          <div className="hidden h-9 items-center gap-x-4 border-b border-border px-3.5 text-[12px] text-muted md:grid" style={{ gridTemplateColumns: GRID }}>
            <span>Contact</span>
            <span>Lists</span>
            <span>Status</span>
            <span className="text-right">Added</span>
          </div>
          {data.contacts.length === 0 && <Empty>{sp.status === "flagged" ? "Nobody is flagged: Shield's flags show here, to approve or unsubscribe." : sp.q || sp.list || sp.status ? "Nobody matches." : "No contacts yet: add them, import a CSV, or point a signup form at a list."}</Empty>}
          {data.contacts.map((c) => (
            <Link key={c.id} href={`/email/${brand.id}/contacts/${c.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-soft px-3.5 py-2.5 text-[13px] last:border-b-0 hover:bg-hover md:grid" style={{ gridTemplateColumns: GRID }} data-testid="contact-row">
              <span className="grid min-w-0 basis-full md:basis-auto">
                <span className="truncate font-bold">{c.email}</span>
                {c.name && <span className="truncate text-[12px] text-muted">{c.name}</span>}
              </span>
              <span className="truncate text-[12px] text-muted">{c.lists.map((id) => lists.find((l) => l.id === id)?.name).filter(Boolean).join(", ") || "–"}</span>
              <span className="flex flex-wrap items-center gap-1">
                <StatusPill status={c.status} />
                {c.flags && (
                  <span title={`Shield: ${c.flags.map(checkLabel).join(", ")}`}>
                    <StatusPill status="flagged" testId="flagged" />
                  </span>
                )}
              </span>
              <span className="text-right text-[12px] text-muted">{when(c.createdAt)}</span>
            </Link>
          ))}
          {pages > 1 && (
            <div className="flex items-center justify-between border-t border-border px-3.5 py-2.5 text-[12px] text-muted">
              <span>
                Page {data.page} of {pages}
              </span>
              <span className="flex gap-1.5">
                {data.page > 1 && (
                  <Link href={href({ page: String(data.page - 1) })} className={buttonClass("secondary", "sm")}>
                    Previous
                  </Link>
                )}
                {data.page < pages && (
                  <Link href={href({ page: String(data.page + 1) })} className={buttonClass("secondary", "sm")}>
                    Next
                  </Link>
                )}
              </span>
            </div>
          )}
        </section>
      )}
      {suppressed && (
        <>
          <Section title="Suppressed" description="Nothing goes to these addresses, transactional email included: hard bounces, spam complaints, and addresses added by hand">
            <div className="border-t border-border px-3.5 py-3">
              <SuppressForm brandId={brand.id} />
            </div>
            <div className="border-t border-border" data-testid="suppressions">
              {suppressed.items.length === 0 && <Empty>Nobody yet.</Empty>}
              {suppressed.items.map((s) => (
                <div key={s.email} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border-soft px-3.5 py-2 text-[13px] last:border-b-0">
                  <span className="grid min-w-0">
                    <span className="truncate">{s.email}</span>
                    {s.detail && <span className="truncate text-[12px] text-muted">{s.detail}</span>}
                  </span>
                  <StatusPill status={s.reason === "bounce" ? "bounced" : s.reason === "complaint" ? "complained" : "manual"} />
                  <UnsuppressButton brandId={brand.id} email={s.email} />
                </div>
              ))}
            </div>
          </Section>
        </>
      )}
    </>
  );
}

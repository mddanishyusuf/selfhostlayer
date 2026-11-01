import Link from "next/link";
import { notFound } from "next/navigation";
import { ContactForm } from "@/components/email-forms";
import { StatusPill, when } from "@/components/email-ui";
import { CARD, Empty, Notice, PageHeader, Section } from "@/components/page";
import { brandFor, contactOf, EmailError, listsOf } from "@/lib/email";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Contact" };

export default async function ContactPage({ params }: { params: Promise<{ brand: string; id: string }> }) {
  await requireUser();
  const { brand: b, id } = await params;
  const ctx = await brandFor(b);
  if (!ctx) return null;
  const { project, brand } = ctx;
  let data: Awaited<ReturnType<typeof contactOf>>;
  let lists;
  try {
    [data, lists] = await Promise.all([contactOf(project, brand.id, Number(id)), listsOf(project, brand.id)]);
  } catch (err) {
    if (err instanceof EmailError && err.status === 404) notFound();
    return (
      <Notice lead="Not reachable" tone="err">
        {(err as Error).message}
      </Notice>
    );
  }
  const c = data.contact;
  return (
    <>
      <PageHeader title={brand.name} crumb={c.email} back={`/email/${brand.id}/contacts`} meta={<span className="inline-flex items-center gap-2"><StatusPill status={c.status} />Added {when(c.createdAt)}{c.source ? ` from ${c.source}` : ""}</span>} />
      {data.suppressed && (
        <Notice lead="Suppressed" tone="err">
          Nothing is sent to this address: it bounced, complained or was added by hand. The Suppressed tab on Contacts can remove it.
        </Notice>
      )}
      <section className={`${CARD} p-3.5`}>
        <ContactForm brandId={brand.id} contact={c} lists={lists} />
      </section>
      <Section title="Emails" description="What this address was sent, newest first">
        <div className="border-t border-border" data-testid="contact-history">
          {data.messages.length === 0 && <Empty>Nothing sent yet.</Empty>}
          {data.messages.map((m) => (
            <Link key={m.id} href={m.campaignId ? `/email/${brand.id}/campaigns/${m.campaignId}` : `/email/${brand.id}/logs?m=${m.id}`} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border-soft px-3.5 py-2 text-[13px] last:border-b-0 hover:bg-hover">
              <span className="grid min-w-0">
                <span className="truncate">{m.subject || "(no subject)"}</span>
                <span className="truncate text-[12px] text-muted">
                  {m.campaign ?? m.kind} · {when(m.sentAt ?? m.createdAt)}
                  {m.openedAt ? " · opened" : ""}
                  {m.clickedAt ? " · clicked" : ""}
                </span>
              </span>
              <StatusPill status={m.status} />
            </Link>
          ))}
        </div>
      </Section>
    </>
  );
}

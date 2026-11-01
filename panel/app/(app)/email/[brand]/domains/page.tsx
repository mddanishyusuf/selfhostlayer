import { ChevronRightIcon } from "lucide-react";
import { AddDomainForm, DomainButtons } from "@/components/email-forms";
import { StatusPill, when } from "@/components/email-ui";
import { CopyButton } from "@/components/form";
import { Icon } from "@/components/icon";
import { CARD, Empty, Notice, PageHeader } from "@/components/page";
import { cx } from "@/components/ui";
import { brandFor, domainsOf, type Domain } from "@/lib/email";

export const dynamic = "force-dynamic";
export const metadata = { title: "Domains" };

export default async function DomainsPage({ params }: { params: Promise<{ brand: string }> }) {
  const ctx = await brandFor((await params).brand);
  if (!ctx) return null;
  const { project, brand } = ctx;
  let domains: Domain[] = [];
  let problem: string | null = null;
  try {
    domains = await domainsOf(project, brand.id);
  } catch (err) {
    problem = (err as Error).message;
  }
  return (
    <>
      <PageHeader title={brand.name} crumb="Domains" meta="Mail goes out only from a verified domain" />
      {brand.provider === "none" && (
        <Notice lead="First" tone="gold">
          set the brand&apos;s provider in Settings: the records depend on it (Amazon SES signs with its own keys).
        </Notice>
      )}
      <section className={`${CARD} p-3.5`}>
        <AddDomainForm brandId={brand.id} />
      </section>
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      {domains.length === 0 && !problem && (
        <section className={CARD}>
          <Empty>No domains yet.</Empty>
        </section>
      )}
      {domains.map((d) => (
        <section key={d.id} className={CARD} data-testid="domain">
          <div className="flex flex-wrap items-center gap-2.5 px-3.5 pb-2.5 pt-3.5">
            <h2 className="text-[14px] font-bold">{d.domain}</h2>
            <StatusPill status={d.status} />
            <span className="text-[12px] text-muted">{d.checkedAt ? `Checked ${when(d.checkedAt)}` : "Not checked yet"}</span>
            <span className="ml-auto">
              <DomainButtons brandId={brand.id} id={d.id} domain={d.domain} />
            </span>
          </div>
          {/* Folded once the domain is verified: the records are only needed again to change something. */}
          <details open={d.status !== "verified"} className="group border-t border-border" data-testid="domain-records">
            <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3.5 py-2.5 text-[13px] transition-colors hover:bg-hover [&::-webkit-details-marker]:hidden">
              <Icon icon={ChevronRightIcon} size={14} className="text-muted transition-transform duration-150 group-open:rotate-90" />
              <span className="font-medium">DNS records</span>
              <span className="text-[12px] text-muted">
                {d.records.filter((r) => r.ok === true).length} of {d.records.length} found
              </span>
              <span className="ml-auto text-[12px] text-muted group-open:hidden">Show</span>
              <span className="ml-auto hidden text-[12px] text-muted group-open:inline">Hide</span>
            </summary>
            <div className="border-t border-border">
            {d.records.map((r) => (
              <div key={`${r.purpose}${r.name}`} className="grid gap-1.5 border-b border-border-soft px-3.5 py-2.5 last:border-b-0">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <b className="font-bold">{r.purpose}</b>
                  <span className="text-[12px] text-muted">{r.required ? "required" : "recommended"}</span>
                  <span className={cx("ml-auto text-[12px]", r.ok === true ? "text-teal" : r.ok === false ? (r.required ? "text-rose" : "text-gold") : "text-dim")}>{r.ok === true ? "Found" : r.ok === false ? (r.found ? "Found, but different" : "Not found") : "Not checked"}</span>
                </div>
                <div className="grid gap-1 sm:grid-cols-[64px_minmax(0,1fr)]">
                  <span className="text-[12px] text-muted">{r.type}</span>
                  <div className="flex items-center gap-2 bg-well px-2.5 py-1.5">
                    <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{r.name}</code>
                    <CopyButton text={r.name} />
                  </div>
                  <span className="text-[12px] text-muted">Value</span>
                  <div className="flex items-start gap-2 bg-well px-2.5 py-1.5">
                    <code className="min-w-0 flex-1 break-all font-mono text-[12px]">{r.value}</code>
                    <CopyButton text={r.value} />
                  </div>
                </div>
                {r.found && r.ok === false && <p className="break-all text-[12px] text-muted">In DNS now: {r.found}</p>}
              </div>
            ))}
            </div>
          </details>
        </section>
      ))}
      <p className="text-[12px] text-dim">SPF: add your provider&apos;s include to the domain&apos;s one SPF record (a domain may have only one). DMARC: start with p=none, then tighten it once mail passes.</p>
    </>
  );
}

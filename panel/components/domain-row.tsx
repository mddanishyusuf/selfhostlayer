import { ArrowUpRight01Icon, Delete02Icon, Globe02Icon, Link01Icon, SquareLock02Icon } from "@hugeicons/core-free-icons";
import { Suspense } from "react";
import { removeDomainAction, verifyDomainAction } from "@/app/actions/domains";
import { checkCertificate } from "@/lib/cert";
import { suggestedRecord } from "@/lib/dns";
import type { ProjectDomain } from "@/lib/domains";
import { CopyButton, SubmitButton } from "./form";
import { Icon } from "./icon";
import { Dot, ListRow, RowIcon } from "./page";
import { StatusText } from "./status";
import { Pill, Skeleton } from "./ui";

/** Certificate state from a real TLS handshake through Caddy. */
async function CertLine({ host, free }: { host: string; free: boolean }) {
  const cert = await checkCertificate(host);
  if (cert.ok) {
    return (
      <>
        <Icon icon={SquareLock02Icon} size={13} className="text-dim" />
        HTTPS
        <Dot />
        {cert.issuer}
        <Dot />
        <span className={cert.daysLeft < 20 ? "text-gold" : undefined}>renews in {cert.daysLeft} days</span>
        {free && (
          <>
            <Dot /> free URL
          </>
        )}
      </>
    );
  }
  const text = {
    issuing: "Issuing a certificate… (usually under a minute)",
    untrusted: "Certificate from a local CA (test box)",
    expired: "Certificate expired",
    unreachable: "Couldn't reach the server on port 443",
  }[cert.reason];
  return <span className={cert.reason === "expired" || cert.reason === "unreachable" ? "text-rose" : cert.reason === "issuing" ? "text-gold" : undefined}>{text}</span>;
}

export function DomainRow({ d, freeHost, serverIp, indent }: { d: ProjectDomain; freeHost: string; serverIp: string; indent?: boolean }) {
  const pending = d.status === "pending";
  const record = pending ? suggestedRecord(d.host, serverIp, freeHost) : null;
  const sub = pending ? (
    <>
      <span className="text-gold">Waiting for DNS</span>
      {d.message && (
        <>
          <Dot /> {d.message}
        </>
      )}
    </>
  ) : d.role === "redirect" ? (
    <>
      Redirects to <b className="font-medium text-foreground">{d.redirectTo}</b>
      <Dot /> 301, keeps the path
    </>
  ) : (
    <Suspense fallback={<Skeleton className="h-3.5 w-56" />}>
      <CertLine host={d.host} free={d.role === "free"} />
    </Suspense>
  );
  return (
    <ListRow
      indent={indent}
      data-host={d.host}
      data-status={d.status}
      lead={<RowIcon tone={pending ? "warn" : d.role === "free" ? "dim" : "ok"}>{<Icon icon={d.role === "redirect" ? Link01Icon : Globe02Icon} size={17} />}</RowIcon>}
      title={
        <>
          <span className="truncate">{d.host}</span>
          {d.role === "free" && <Pill outline>Free</Pill>}
        </>
      }
      sub={sub}
      side={
        <>
          <span className="max-sm:hidden">{pending ? <StatusText status="warn" label="Pending" pulse /> : <StatusText status="ok" label="Live" />}</span>
          <a href={`https://${d.host}`} target="_blank" rel="noreferrer" title={`Open ${d.host}`} className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-foreground">
            <Icon icon={ArrowUpRight01Icon} size={16} />
          </a>
          {d.role !== "free" && (
            <form action={removeDomainAction}>
              <input type="hidden" name="domainId" value={d.id} />
              <button type="submit" title={`Remove ${d.host}`} className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-foreground">
                <Icon icon={Delete02Icon} size={15} />
                <span className="sr-only">Remove {d.host}</span>
              </button>
            </form>
          )}
        </>
      }
    >
      {record && (
        <div className="col-span-full mt-3.5 grid gap-3 border-l-2 border-gold bg-gold/7 px-[18px] py-3.5 md:col-start-2" data-testid="dns-record">
          <p className="text-[13.5px] text-muted">Add this record at your DNS provider. The domain goes live once public DNS points it here, so visitors never land on a broken site.</p>
          <div className="grid items-end gap-x-[18px] gap-y-2.5 sm:grid-cols-[80px_110px_minmax(0,1fr)_auto]">
            <div>
              <span className="mb-0.5 block text-[12px] text-dim">Type</span>
              <code className="font-mono text-[13.5px]">{record.type}</code>
            </div>
            <div>
              <span className="mb-0.5 block text-[12px] text-dim">Name</span>
              <code className="font-mono text-[13.5px]">{record.name}</code>
            </div>
            <div className="min-w-0">
              <span className="mb-0.5 block text-[12px] text-dim">Value</span>
              <code className="block truncate font-mono text-[13.5px]">{record.value}</code>
            </div>
            <div className="flex items-center gap-1.5">
              <CopyButton text={record.value} />
              <form action={verifyDomainAction}>
                <input type="hidden" name="domainId" value={d.id} />
                <SubmitButton pending="Checking…" size="sm" className="w-auto">
                  Check again
                </SubmitButton>
              </form>
            </div>
          </div>
        </div>
      )}
    </ListRow>
  );
}

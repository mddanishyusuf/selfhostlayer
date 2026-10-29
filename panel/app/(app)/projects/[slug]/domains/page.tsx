import { ArrowRight, Lock, LockOpen, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { removeDomainAction, verifyDomainAction } from "@/app/actions/domains";
import { AddDomainForm } from "@/components/domains";
import { CopyButton, SubmitButton } from "@/components/form";
import { Card, Skeleton, StatusDot } from "@/components/ui";
import { boxConfig } from "@/lib/box";
import { checkCertificate } from "@/lib/cert";
import { suggestedRecord } from "@/lib/dns";
import { listDomains, type ProjectDomain } from "@/lib/domains";
import { getProjectBySlug } from "@/lib/projects";
import { PageBody, PageHeader } from "@/components/page";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: `${(await params).slug} domains` };
}

/** Certificate status for a live domain: a real TLS handshake through Caddy. */
async function CertStatus({ host }: { host: string }) {
  const cert = await checkCertificate(host);
  if (cert.ok) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] text-muted">
        <Lock className="size-3.5 text-ok" aria-hidden /> {cert.issuer} · expires in {cert.daysLeft} days
      </span>
    );
  }
  const text = {
    issuing: "Issuing certificate… (usually under a minute)",
    untrusted: "Certificate from a local CA (test box)",
    expired: "Certificate expired",
    unreachable: "Couldn't reach the server on port 443",
  }[cert.reason];
  const Icon = cert.reason === "issuing" || cert.reason === "untrusted" ? LockOpen : TriangleAlert;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[13px] ${cert.reason === "expired" || cert.reason === "unreachable" ? "text-err" : "text-muted"}`}>
      <Icon className="size-3.5" aria-hidden /> {text}
    </span>
  );
}

function DomainRow({ d, freeHost, serverIp }: { d: ProjectDomain; freeHost: string; serverIp: string }) {
  const record = suggestedRecord(d.host, serverIp, freeHost);
  return (
    <div className="grid gap-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusDot status={d.status === "active" ? "ok" : "warn"} />
        <a href={`https://${d.host}`} target="_blank" rel="noreferrer" className="font-medium underline-offset-4 hover:underline">
          {d.host}
        </a>
        <span className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-muted">
          {d.role === "free" ? "Free URL" : d.role === "primary" ? "Domain" : "Redirect"}
        </span>
        {d.role === "redirect" && (
          <span className="inline-flex items-center gap-1 text-[13px] text-muted">
            <ArrowRight className="size-3.5" aria-hidden /> {d.redirectTo}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {d.status === "pending" && (
            <form action={verifyDomainAction}>
              <input type="hidden" name="domainId" value={d.id} />
              <SubmitButton pending="Checking…" className="h-8 w-auto px-3 text-[13px]">
                Verify
              </SubmitButton>
            </form>
          )}
          {d.role !== "free" && (
            <form action={removeDomainAction}>
              <input type="hidden" name="domainId" value={d.id} />
              <button type="submit" className="h-8 rounded-md px-3 text-[13px] text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground">
                Remove
              </button>
            </form>
          )}
        </div>
      </div>
      {d.status === "active" ? (
        <Suspense fallback={<Skeleton className="h-4 w-56" />}>
          <CertStatus host={d.host} />
        </Suspense>
      ) : (
        <div className="grid gap-3 rounded-md border border-border bg-subtle p-4">
          <p className="text-[13px]">{d.message ?? "Waiting for DNS."}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="text-muted">
                <tr>
                  <th className="pb-1.5 pr-6 font-medium">Type</th>
                  <th className="pb-1.5 pr-6 font-medium">Name</th>
                  <th className="pb-1.5 font-medium">Value</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                <tr>
                  <td className="pr-6">{record.type}</td>
                  <td className="pr-6">{record.name}</td>
                  <td className="flex items-center gap-1">
                    {record.value} <CopyButton text={record.value} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-[12px] text-muted">The domain goes live only after it points at this server, so visitors never land on a broken site.</p>
        </div>
      )}
    </div>
  );
}

export default async function DomainsPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project) notFound();
  const domains = listDomains(project.id);
  const box = boxConfig();
  const freeHost = domains.find((d) => d.role === "free")?.host ?? project.domains[0]!;

  return (
    <>
      <PageHeader
        title="Domains"
        subtitle={`${project.slug} · certificates are issued and renewed automatically`}
      />
      <PageBody>
      <Card className="p-5">
        <AddDomainForm slug={project.slug} />
      </Card>
      <Card className="divide-y divide-border overflow-hidden">
        {domains.map((d) => (
          <DomainRow key={d.id} d={d} freeHost={freeHost} serverIp={box.publicIp} />
        ))}
      </Card>
      </PageBody>
    </>
  );
}

import { notFound } from "next/navigation";
import { AddDomainForm } from "@/components/domains";
import { DomainRow } from "@/components/domain-row";
import { KeyValues, Notice, PageHeader, SettingsRow } from "@/components/page";
import { boxConfig } from "@/lib/box";
import { listDomains } from "@/lib/domains";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: `${(await params).slug} domains` };
}

export default async function DomainsPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project) notFound();
  const domains = listDomains(project.id);
  const box = boxConfig();
  const pending = domains.filter((d) => d.status === "pending");

  return (
    <>
      <PageHeader title={project.slug} crumb="Domains" meta="Verified through public DNS before going live" />
      {pending.length > 0 && <Notice lead="Needs attention">{pending.map((d) => d.host).join(", ")} {pending.length === 1 ? "is" : "are"} waiting for DNS. Add the record shown below at your DNS provider.</Notice>}
      <SettingsRow title="Add a domain" description="Point it at this server first. We check public DNS, so visitors never land on a broken site.">
        <AddDomainForm slug={project.slug} />
      </SettingsRow>
      <section className="border-b border-border" data-testid="domain-list">
        {domains.map((d) => (
          <DomainRow key={d.id} d={d} serverIp={box.publicIp} />
        ))}
      </section>
      <SettingsRow title="How it works">
        <KeyValues
          inset
          items={[
            ["DNS check", "Cloudflare and Google public DNS must both point here"],
            ["Certificates", "Let's Encrypt, issued in under a minute and renewed automatically"],
            ["Redirects", "www goes to the domain with a 301, keeping the path"],
          ]}
        />
      </SettingsRow>
    </>
  );
}

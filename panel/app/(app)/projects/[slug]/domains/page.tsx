import { notFound } from "next/navigation";
import { restoreFreeDomainAction } from "@/app/actions/domains";
import { AddDomainForm } from "@/components/domains";
import { DomainRow } from "@/components/domain-row";
import { KeyValues, Notice, PageHeader, SettingsRow } from "@/components/page";
import { Button } from "@/components/ui";
import { boxConfig, freeHost } from "@/lib/box";
import { canRemove, listDomains } from "@/lib/domains";
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
          <DomainRow key={d.id} d={d} serverIp={box.publicIp} removable={canRemove(d)} />
        ))}
        {!domains.some((d) => d.role === "free") && (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border px-4 py-3.5 text-[13.5px] text-muted sm:px-7" data-testid="free-off">
            <span>
              The free address <code className="font-mono text-[13px] text-foreground">{freeHost(project.slug, box)}</code> is off.
            </span>
            <form action={restoreFreeDomainAction}>
              <input type="hidden" name="slug" value={project.slug} />
              <Button type="submit" variant="secondary" size="sm">
                Add it back
              </Button>
            </form>
          </div>
        )}
      </section>
      <SettingsRow title="How it works">
        <KeyValues
          inset
          items={[
            ["DNS check", "Cloudflare and Google public DNS must both point here"],
            ["Certificates", "Let's Encrypt, issued in under a minute and renewed automatically"],
            ["Redirects", "www goes to the domain with a 301, keeping the path"],
            ["Free address", "Removable once one of your own domains is live; you can add it back"],
          ]}
        />
      </SettingsRow>
    </>
  );
}

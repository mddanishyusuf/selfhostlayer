import { Add01Icon } from "@hugeicons/core-free-icons";
import { Collapsible } from "@/components/collapsible";
import { DomainRow } from "@/components/domain-row";
import { Icon } from "@/components/icon";
import { Dot, Empty, Notice, PageHeader, PillLink, Tabs } from "@/components/page";
import { StatusText } from "@/components/status";
import { Mark } from "@/components/ui";
import { listIncidents } from "@/lib/alerts/engine";
import { boxConfig } from "@/lib/box";
import { listAllDomains, type ProjectDomain } from "@/lib/domains";
import { listProjects } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Domains" };

export default async function AllDomainsPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  await requireUser();
  const tab = (await searchParams).t === "attention" ? "attention" : "all";
  const box = boxConfig();
  const domains = listAllDomains();
  // A failing certificate shows up as an open alert from the monitor, which
  // already checks every live domain: cheaper than a handshake per domain here.
  const certIssues = new Set(listIncidents().filter((i) => !i.resolvedAt && i.key.startsWith("cert:")).map((i) => i.key.slice(5)));
  const attention = (d: ProjectDomain) => d.status === "pending" || certIssues.has(d.host);
  const projects = listProjects();
  const groups = projects
    .map((p, index) => ({ p, index, all: domains.filter((d) => d.projectId === p.id) }))
    .filter((g) => g.all.length > 0)
    .map((g) => ({ ...g, shown: tab === "attention" ? g.all.filter(attention) : g.all }))
    .filter((g) => g.shown.length > 0);
  const issues = domains.filter(attention);

  return (
    <>
      <PageHeader
        title="Domains"
        meta={`${domains.length} domain${domains.length === 1 ? "" : "s"} · certificates renew automatically`}
        actions={
          projects[0] && (
            <PillLink href={`/projects/${projects[0].slug}/domains`} primary>
              <Icon icon={Add01Icon} size={16} strokeWidth={2} /> Add domain
            </PillLink>
          )
        }
      />
      {issues.length > 0 && (
        <Notice lead="Needs attention">
          {issues
            .slice(0, 2)
            .map((d) => (d.status === "pending" ? `${d.host} is waiting for DNS` : `the certificate for ${d.host} has a problem`))
            .join(", and ")}
          {issues.length > 2 ? `, and ${issues.length - 2} more` : ""}.
        </Notice>
      )}
      <Tabs
        items={[
          { href: "/domains", label: "All projects", count: projects.filter((p) => domains.some((d) => d.projectId === p.id)).length, active: tab === "all" },
          { href: "/domains?t=attention", label: "Needs attention", count: issues.length, active: tab === "attention" },
        ]}
      />
      {groups.length === 0 && <Empty>{tab === "attention" ? "Nothing needs attention. Every domain is live with a valid certificate." : "No domains yet."}</Empty>}
      {groups.map(({ p, index, all, shown }) => {
        const free = all.find((d) => d.role === "free")?.host ?? p.domains[0]!;
        const main = all.find((d) => d.role === "primary" && d.status === "active") ?? all.find((d) => d.role === "primary") ?? all[0]!;
        const problems = all.filter(attention);
        return (
          <Collapsible
            key={p.id}
            testId={`domains-${p.slug}`}
            defaultOpen={tab === "attention"}
            lead={<Mark name={p.slug} index={index} />}
            title={<span className="truncate">{p.slug}</span>}
            sub={
              problems.length ? (
                <span className="truncate text-gold">{problems[0]!.status === "pending" ? `${problems[0]!.host} is waiting for DNS` : `Certificate problem on ${problems[0]!.host}`}</span>
              ) : (
                <>
                  <span className="truncate">{main.host}</span>
                  {all.length > 1 && (
                    <>
                      <Dot />
                      <span className="text-dim">+{all.length - 1} more</span>
                    </>
                  )}
                </>
              )
            }
            side={
              <>
                <span className="whitespace-nowrap text-[13px] text-dim max-md:hidden">
                  {all.length} domain{all.length === 1 ? "" : "s"}
                </span>
                <span className="max-sm:hidden">
                  {problems.some((d) => d.status === "pending") ? <StatusText status="warn" label="Pending" pulse /> : problems.length ? <StatusText status="warn" label="Needs attention" /> : <StatusText status="ok" label="Live" />}
                </span>
              </>
            }
          >
            {shown.map((d) => (
              <DomainRow key={d.id} d={d} freeHost={free} serverIp={box.publicIp} indent />
            ))}
            <div className="flex items-center gap-4 border-t border-border py-3 pl-4 pr-4 text-[13px] sm:pr-7 md:pl-[82px]">
              <a href={`/projects/${p.slug}/domains`} className="text-lavender hover:underline">
                + Add a domain to {p.slug}
              </a>
              <a href={`/projects/${p.slug}/domains`} className="ml-auto text-lavender hover:underline">
                Open {p.slug} domains
              </a>
            </div>
          </Collapsible>
        );
      })}
    </>
  );
}

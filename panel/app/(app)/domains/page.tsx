import { Add01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/icon";
import { CARD, Dot, Empty, ListRow, Notice, PageHeader, PillLink, Tabs } from "@/components/page";
import { StatusText } from "@/components/status";
import { buttonClass } from "@/components/ui";
import { listIncidents } from "@/lib/alerts/engine";
import { listAllDomains, type ProjectDomain } from "@/lib/domains";
import { listProjects } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Domains" };

export default async function AllDomainsPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  await requireUser();
  const tab = (await searchParams).t === "attention" ? "attention" : "all";
  const domains = listAllDomains();
  // A failing certificate shows up as an open alert from the monitor, which
  // already checks every live domain: cheaper than a handshake per domain here.
  const certIssues = new Set(listIncidents().filter((i) => !i.resolvedAt && i.key.startsWith("cert:")).map((i) => i.key.slice(5)));
  const attention = (d: ProjectDomain) => d.status === "pending" || certIssues.has(d.host);
  const projects = listProjects();
  const groups = projects
    .map((p) => ({ p, all: domains.filter((d) => d.projectId === p.id) }))
    .filter((g) => g.all.length > 0)
    .filter((g) => tab === "all" || g.all.some(attention));
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
      {groups.length > 0 && (
        <section className={CARD}>
          {groups.map(({ p, all }) => {
            // A domain that works leads; a pending one is named below, in the warning.
            const main = all.find((d) => d.role === "primary" && d.status === "active") ?? all.find((d) => d.status === "active") ?? all.find((d) => d.role === "primary") ?? all[0]!;
            const problems = all.filter(attention);
            return (
              // The whole row opens the project's Domains page, where domains are added and checked.
              <ListRow
                key={p.id}
                href={`/projects/${p.slug}/domains`}
                data-testid={`domains-${p.slug}`}
                title={<span className="truncate">{main.host}</span>}
                sub={
                  <>
                    <span className="shrink-0">{p.slug}</span>
                    {problems.length ? (
                      <>
                        <Dot />
                        <span className="truncate text-gold">{problems[0]!.status === "pending" ? `${problems[0]!.host} is waiting for DNS` : `Certificate problem on ${problems[0]!.host}`}</span>
                      </>
                    ) : (
                      all.length > 1 && (
                        <>
                          <Dot />
                          <span className="text-dim">+{all.length - 1} more</span>
                        </>
                      )
                    )}
                  </>
                }
                side={
                  <>
                    <span className="whitespace-nowrap text-[13px] text-dim max-md:hidden">
                      {all.length} domain{all.length === 1 ? "" : "s"}
                    </span>
                    <span className="max-sm:hidden">
                      {problems.some((d) => d.status === "pending") ? (
                        <StatusText status="warn" label="Pending" pulse />
                      ) : problems.length ? (
                        <StatusText status="warn" label="Needs attention" />
                      ) : (
                        <StatusText status="ok" label="Live" />
                      )}
                    </span>
                    <span className={buttonClass("secondary", "sm")}>Manage</span>
                  </>
                }
              />
            );
          })}
        </section>
      )}
    </>
  );
}

import { Add01Icon, GitBranchIcon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import { FilterBox, ServerButton } from "@/components/header-controls";
import { Icon } from "@/components/icon";
import { Dot, Empty, Notice, PageHeader, PillLink } from "@/components/page";
import { DeployStatusBadge, timeAgo } from "@/components/status";
import { Mark, StatusDot, cx } from "@/components/ui";
import { agent, type SystemInfo } from "@/lib/agent";
import { frameworkLabel } from "@/lib/detect";
import { FINISHED, listDeployments, liveDeployment } from "@/lib/deploy";
import { servingConfig } from "@/lib/domains";
import { allRepos } from "@/lib/github-repos";
import { getApp } from "@/lib/github-store";
import { listProjects } from "@/lib/projects";

export const dynamic = "force-dynamic";
export const metadata = { title: "Projects" };

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  // Warm the New project list in the background, so it opens without waiting on GitHub.
  if (getApp()) void allRepos().catch(() => {});
  const all = listProjects();
  const term = q?.trim().toLowerCase();
  const projects = term ? all.filter((p) => `${p.slug} ${p.domains.join(" ")} ${p.repoName}`.toLowerCase().includes(term)) : all;
  const info = await agent<SystemInfo>("system.info").catch(() => null);
  const rows = projects.map((p) => {
    const latest = listDeployments(p.id, 1)[0];
    const live = liveDeployment(p.id);
    const hosts = servingConfig(p.id).domains;
    const host = hosts.find((h) => h !== p.domains[0]) ?? hosts[0] ?? p.domains[0];
    const building = !!latest && !FINISHED.includes(latest.status);
    return { p, latest, live, host, building };
  });
  const deploying = rows.find((r) => r.building);

  return (
    <>
      <PageHeader
        title="Projects"
        actions={
          info && (
            <ServerButton>
              <StatusDot status={info.caddy === "active" ? "ok" : "err"} />
              <b className="font-semibold text-foreground">{info.hostname}</b>
              <span className="hidden sm:inline">
                <span className="text-dim">·</span> CPU {Math.round(((info.loadavg[0] ?? 0) / info.cpus) * 100)}% <span className="text-dim">·</span> RAM{" "}
                {Math.round(((info.memoryMb.total - info.memoryMb.available) / info.memoryMb.total) * 100)}%
              </span>
            </ServerButton>
          )
        }
      />
      {all.length > 0 && (
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3 sm:px-7">
          <FilterBox placeholder="Search projects" className="flex-1" />
          <PillLink href="/new" primary>
            <Icon icon={Add01Icon} size={16} strokeWidth={2} /> New project
          </PillLink>
        </div>
      )}
      {deploying?.latest && (
        <Notice lead="Building">
          {deploying.p.slug} is deploying <code className="font-mono text-[13px]">{deploying.latest.sha.slice(0, 7)}</code> “{deploying.latest.commitMessage || "deployment"}”, started{" "}
          {timeAgo(deploying.latest.createdAt)}.
        </Notice>
      )}

      {all.length === 0 ? (
        <Empty
          action={
            <PillLink href="/new" primary>
              New project
            </PillLink>
          }
        >
          <p className="text-[17px] font-semibold text-foreground">No projects yet</p>
          <p>Connect GitHub to deploy your first app. Each one runs as its own sandboxed user.</p>
        </Empty>
      ) : (
        <div className="border-b border-border" data-testid="project-list">
          {rows.length === 0 && <Empty>No projects match “{q}”.</Empty>}
          {rows.map(({ p, latest, live, host, building }) => {
            // Worth saying even while an older build still serves the site.
            const failed = latest?.status === "failed";
            return (
              <Link
                key={p.id}
                href={`/projects/${p.slug}`}
                className={cx(
                  "relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 border-t border-border px-4 py-4 transition-colors duration-150 first:border-t-0 hover:bg-hover sm:px-7",
                  building && "sweep-top",
                )}
              >
                <Mark framework={p.framework} />
                <div className="grid min-w-0 gap-[3px]">
                  <div className="flex min-w-0 items-baseline gap-2.5">
                    <b className="whitespace-nowrap text-[15.5px] font-semibold">{p.slug}</b>
                    <span className="truncate text-[13.5px] text-muted max-sm:hidden">{live && host ? host : "Not live yet"}</span>
                  </div>
                  <div className="flex min-w-0 items-center gap-[7px] truncate whitespace-nowrap text-[13.5px] text-muted">
                    {building && <span className="font-medium text-gold">Deploying</span>}
                    {failed && <span className="font-medium text-rose">Build failed</span>}
                    <span className="truncate text-foreground">{latest?.commitMessage || (latest ? `Commit ${latest.sha.slice(0, 7)}` : "No deployments yet")}</span>
                    {latest && (
                      <>
                        <span className="contents max-md:hidden">
                          <Dot />
                          <Icon icon={GitBranchIcon} size={13} className="text-dim" />
                          <span>{p.branch}</span>
                          <Dot />
                          <code className="font-mono text-[12.5px]">{latest.sha.slice(0, 7)}</code>
                        </span>
                        <Dot />
                        <span>{timeAgo(latest.createdAt)}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="grid justify-items-end gap-1">
                  {latest ? <DeployStatusBadge status={building ? latest.status : live ? "ready" : latest.status} /> : <span className="text-[13.5px] text-muted">Not deployed</span>}
                  <span className="whitespace-nowrap text-[12.5px] text-dim max-sm:hidden">
                    {frameworkLabel(p.framework)} · {p.runtime.kind === "static" ? "static" : `Node ${p.nodeVersion}`}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}

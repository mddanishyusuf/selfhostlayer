import { ArrowUpRight, GitBranch, ServerCrash } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { PageBody, PageHeader, PillLink, RowList, Section } from "@/components/page";
import { DeployStatusBadge, timeAgo } from "@/components/status";
import { Skeleton, cx } from "@/components/ui";
import { agent, type SystemInfo } from "@/lib/agent";
import { frameworkLabel } from "@/lib/detect";
import { listDeployments, liveDeployment } from "@/lib/deploy";
import { servingConfig } from "@/lib/domains";
import { listProjects } from "@/lib/projects";

export const dynamic = "force-dynamic";
export const metadata = { title: "Projects" };

export default function ProjectsPage() {
  return (
    <>
      <PageHeader
        title="Projects"
        actions={
          // The sidebar has the button on bigger screens.
          <span className="md:hidden">
            <PillLink href="/new" primary>
              <GitBranch className="size-4" aria-hidden /> New project
            </PillLink>
          </span>
        }
      />
      <PageBody>
        {/* On wide screens the right column shows the server instead. */}
        <div className="xl:hidden">
          <Suspense fallback={<Skeleton className="h-[74px] w-full rounded-2xl" />}>
            <ServerStrip />
          </Suspense>
        </div>
        <Projects />
      </PageBody>
    </>
  );
}

async function ServerStrip() {
  let info: SystemInfo;
  try {
    info = await agent<SystemInfo>("system.info");
  } catch {
    return (
      <p className="flex items-center gap-2 rounded-2xl border border-border px-4 py-3 text-[14px]">
        <ServerCrash className="size-4 text-err" aria-hidden /> Can&apos;t reach the server agent. On the server: <code className="font-mono text-[13px]">systemctl status layer-agent</code>
      </p>
    );
  }
  const memUsed = info.memoryMb.total - info.memoryMb.available;
  const diskUsed = info.diskGb.total - info.diskGb.free;
  const stats = [
    ["CPU", `${Math.round(((info.loadavg[0] ?? 0) / info.cpus) * 100)}%`],
    ["Memory", `${(memUsed / 1024).toFixed(1)} / ${(info.memoryMb.total / 1024).toFixed(1)} GB`],
    ["Disk", `${diskUsed.toFixed(1)} / ${info.diskGb.total} GB`],
  ];
  return (
    <div className="grid grid-cols-3 divide-x divide-border rounded-2xl border border-border">
      {stats.map(([label, value]) => (
        <div key={label} className="grid gap-0.5 px-4 py-3">
          <p className="text-[13px] text-muted">{label}</p>
          <p className="truncate text-[15px] font-bold tabular-nums">{value}</p>
        </div>
      ))}
    </div>
  );
}

function Projects() {
  const projects = listProjects();
  if (projects.length === 0) {
    return (
      <div className="grid justify-items-center gap-4 rounded-2xl border border-dashed border-border-strong px-6 py-16 text-center">
        <div className="grid gap-1">
          <p className="text-[17px] font-bold">No projects yet</p>
          <p className="text-muted">Connect GitHub to deploy your first app. Each one runs as its own sandboxed user.</p>
        </div>
        <PillLink href="/new" primary>
          New project
        </PillLink>
      </div>
    );
  }
  return (
    <Section title={`${projects.length} project${projects.length === 1 ? "" : "s"}`}>
      <RowList>
        {projects.map((p) => {
          const latest = listDeployments(p.id, 1)[0];
          const live = liveDeployment(p.id);
          const hosts = servingConfig(p.id).domains;
          const host = hosts.find((h) => h !== p.domains[0]) ?? hosts[0] ?? p.domains[0];
          return (
            <div key={p.id} className="relative flex items-start gap-4 px-4 py-4 transition-colors duration-150 hover:bg-subtle sm:px-5">
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-subtle text-[15px] font-bold uppercase" aria-hidden>
                {p.slug.slice(0, 1)}
              </span>
              <div className="grid min-w-0 flex-1 gap-1">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <Link href={`/projects/${p.slug}`} className="text-[15px] font-bold after:absolute after:inset-0">
                    {p.slug}
                  </Link>
                  <span className="truncate text-[14px] text-muted">
                    {p.repoOwner}/{p.repoName} · {frameworkLabel(p.framework)}
                  </span>
                </p>
                <p className={cx("truncate text-[14px]", host ? "" : "text-muted")}>{live && host ? host : "Not live yet"}</p>
                {latest && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
                    <DeployStatusBadge status={latest.status} />
                    <span className="truncate">{latest.commitMessage || latest.sha.slice(0, 7)}</span>
                    <span className="tabular-nums">{timeAgo(latest.createdAt)}</span>
                  </div>
                )}
              </div>
              {live && host && (
                <a
                  href={`https://${host}`}
                  target="_blank"
                  rel="noreferrer"
                  title={`Open ${host}`}
                  className="relative z-[1] grid size-9 shrink-0 place-items-center rounded-full text-muted transition-colors duration-150 hover:bg-accent/10 hover:text-accent"
                >
                  <ArrowUpRight className="size-[18px]" aria-hidden />
                  <span className="sr-only">Open {host}</span>
                </a>
              )}
            </div>
          );
        })}
      </RowList>
    </Section>
  );
}

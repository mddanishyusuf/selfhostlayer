import { ClockIcon, GitBranchIcon, LayoutGridIcon, MenuIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { FilterBox } from "@/components/header-controls";
import { Icon } from "@/components/icon";
import { CARD, Empty, Notice, PageHeader, PillLink, Segmented } from "@/components/page";
import { SitePreviewFrame, SitePreviewSkeleton } from "@/components/site-preview";
import { StatusChip, timeAgo } from "@/components/status";
import { ProjectMark, cx } from "@/components/ui";
import { projectMarks } from "@/lib/avatar";
import { frameworkLabel } from "@/lib/detect";
import { FINISHED, listDeployments, liveDeployment, type Deployment } from "@/lib/deploy";
import { servingConfig } from "@/lib/domains";
import { allRepos } from "@/lib/github-repos";
import { getApp } from "@/lib/github-store";
import { latestUsage } from "@/lib/metrics";
import { listProjects, type Project } from "@/lib/projects";
import { listServers } from "@/lib/servers";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Projects" };

type State = "live" | "building" | "failed" | "idle";
const STATE: Record<State, { dot: "ok" | "warn" | "err" | "idle"; label: string }> = {
  live: { dot: "ok", label: "Ready" },
  building: { dot: "warn", label: "Building" },
  failed: { dot: "err", label: "Build failed" },
  idle: { dot: "idle", label: "Not deployed" },
};
const FILTERS = [
  ["all", "All"],
  ["live", "Live"],
  ["building", "Building"],
  ["failed", "Failed"],
] as const;
type Filter = (typeof FILTERS)[number][0];

// Project, latest deployment, resources, status. Narrower screens drop resources, then the deployment.
const COLUMNS = "grid-cols-[40px_minmax(0,1fr)_auto] md:grid-cols-[40px_minmax(150px,1fr)_minmax(0,1.4fr)_150px] xl:grid-cols-[40px_minmax(170px,1.1fr)_minmax(0,1.6fr)_160px_150px]";

function Meter({ label, value, fraction, hot }: { label: string; value: string; fraction: number; hot: boolean }) {
  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)_52px] items-center gap-2 text-[11px] text-muted">
      {label}
      <span className="h-1 overflow-hidden bg-track">
        <span className={cx("block h-full", hot ? "bg-warn-dot" : "bg-accent")} style={{ width: `${Math.max(1, Math.min(100, fraction * 100))}%` }} />
      </span>
      <span className="text-right font-mono tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function Commit({ project, latest }: { project: Project; latest?: Deployment }) {
  if (!latest) return <span className="text-dim">No deployments yet</span>;
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="truncate">{latest.commitMessage || `Commit ${latest.sha.slice(0, 7)}`}</span>
      <span className="flex min-w-0 items-center gap-3 whitespace-nowrap text-[12px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Icon icon={GitBranchIcon} size={14} />
          {project.branch}
        </span>
        <code className="font-mono text-[11.5px]">{latest.sha.slice(0, 7)}</code>
        <span className="inline-flex items-center gap-1.5">
          <Icon icon={ClockIcon} size={14} />
          {timeAgo(latest.createdAt)}
        </span>
      </span>
    </div>
  );
}

function StateWord({ state }: { state: State }) {
  return <StatusChip status={STATE[state].dot} label={STATE[state].label} pulse={state === "building"} />;
}

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; view?: string; server?: string }> }) {
  await requireUser();
  const { q, status, view, server } = await searchParams;
  // With other servers: each row names its server, and tabs pick one.
  const servers = listServers();
  const serverName = (id: number | null) => (id === null ? "This server" : (servers.find((x) => x.id === id)?.name ?? "?"));
  const onServer = server === "here" ? null : servers.find((x) => String(x.id) === server)?.id;
  // Warm the New project list in the background, so it opens without waiting on GitHub.
  if (getApp()) void allRepos().catch(() => {});
  // Sites have their own page.
  const all = listProjects().filter((p) => p.source === "github");
  // Each project's own mark, oldest first so a new project never changes an older one's.
  const marks = projectMarks(all.toSorted((a, b) => a.id - b.id).map((p) => p.slug));
  const term = q?.trim().toLowerCase();
  const matching = term ? all.filter((p) => `${p.slug} ${p.domains.join(" ")} ${p.repoName}`.toLowerCase().includes(term)) : all;
  const usage = latestUsage();
  const rows = matching.map((p) => {
    const latest = listDeployments(p.id, 1)[0];
    const live = liveDeployment(p.id);
    const hosts = servingConfig(p.id).domains;
    // A custom domain (not the free URL) is the one to show, once it's live.
    const host = hosts.find((h) => h !== p.domains[0]) ?? hosts[0] ?? p.domains[0];
    const building = !!latest && !FINISHED.includes(latest.status);
    // A failed build is worth saying even while an older one still serves the site.
    const state: State = building ? "building" : latest?.status === "failed" ? "failed" : live ? "live" : "idle";
    return { p, latest, live, host, hosts, state };
  });
  const filter: Filter = FILTERS.some(([k]) => k === status) ? (status as Filter) : "all";
  const byServer = server === undefined || onServer === undefined ? rows : rows.filter((r) => r.p.serverId === onServer);
  const shown = filter === "all" ? byServer : byServer.filter((r) => r.state === filter);
  const grid = view === "grid";
  const deploying = rows.find((r) => r.state === "building");
  const href = (next: { status?: Filter; view?: "grid" | "list" }) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    const s = next.status ?? filter;
    if (s !== "all") params.set("status", s);
    if ((next.view ?? (grid ? "grid" : "list")) === "grid") params.set("view", "grid");
    return params.size ? `/?${params}` : "/";
  };

  return (
    <>
      <PageHeader
        title="Projects"
        actions={
          <PillLink href="/new" primary>
            <Icon icon={PlusIcon} size={16} strokeWidth={2} /> New project
          </PillLink>
        }
      />
      {deploying?.latest && (
        <Notice lead="Building">
          {deploying.p.slug} is deploying <code className="font-mono text-[13px]">{deploying.latest.sha.slice(0, 7)}</code> “{deploying.latest.commitMessage || "deployment"}”, started{" "}
          {timeAgo(deploying.latest.createdAt)}.{" "}
          <Link href={`/projects/${deploying.p.slug}/deployments/${deploying.latest.id}`} className="text-accent hover:underline">
            View logs
          </Link>
        </Notice>
      )}
      {all.length > 0 && (
        <div className="flex flex-wrap items-center gap-2.5">
          <Segmented items={FILTERS.map(([k, label]) => ({ href: href({ status: k }), label, count: k === "all" ? rows.length : rows.filter((r) => r.state === k).length, active: filter === k }))} />
          {servers.length > 0 && (
            <Segmented
              items={[
                { href: `/?${new URLSearchParams({ ...(status ? { status } : {}), ...(view ? { view } : {}) })}`, label: "All servers", active: server === undefined || onServer === undefined },
                { href: `/?${new URLSearchParams({ ...(status ? { status } : {}), ...(view ? { view } : {}), server: "here" })}`, label: "This server", active: onServer === null },
                ...servers.map((x) => ({ href: `/?${new URLSearchParams({ ...(status ? { status } : {}), ...(view ? { view } : {}), server: String(x.id) })}`, label: x.name, active: onServer === x.id })),
              ]}
            />
          )}
          <FilterBox placeholder="Search projects, domains, repos" className="order-last min-w-full flex-1 sm:order-none sm:ml-auto sm:min-w-[220px] sm:max-w-[340px]" />
          <Segmented
            items={[
              { href: href({ view: "list" }), label: <Icon icon={MenuIcon} size={15} />, title: "List", active: !grid },
              { href: href({ view: "grid" }), label: <Icon icon={LayoutGridIcon} size={15} />, title: "Grid", active: grid },
            ]}
          />
        </div>
      )}

      {all.length === 0 ? (
        <section className={CARD}>
        <Empty
          action={
            <PillLink href="/new" primary>
              New project
            </PillLink>
          }
        >
          <p className="text-[17px] font-bold text-foreground">No projects yet</p>
          <p>Connect GitHub to deploy your first app. Each one runs as its own sandboxed user.</p>
        </Empty>
        </section>
      ) : shown.length === 0 ? (
        <section className={CARD}>
          <Empty>{q ? `No projects match “${q}”.` : "No projects here."}</Empty>
        </section>
      ) : grid ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3.5" data-testid="project-list">
          {shown.map(({ p, latest, live, host, hosts, state }) => (
            <div key={p.id} className={cx(CARD, "grid content-start gap-3.5 p-2.5 pb-4")}>
              {host && (
                <Suspense fallback={<SitePreviewSkeleton host={host} />}>
                  <SitePreviewFrame slug={p.slug} framework={p.framework} deploymentId={live?.id ?? null} url={`https://${host}`} own={hosts.length ? hosts : p.domains} />
                </Suspense>
              )}
              <Link href={`/projects/${p.slug}`} className="group grid gap-2.5 px-2">
                <div className="flex min-w-0 items-center gap-3">
                  <ProjectMark src={marks.get(p.slug)!} framework={p.framework} size="sm" />
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <b className="truncate font-bold group-hover:underline">{p.slug}</b>
                    <span className="truncate text-[12px] text-muted">{live && host ? host : "Not live yet"}</span>
                  </div>
                  <StateWord state={state} />
                </div>
                <Commit project={p} latest={latest} />
              </Link>
            </div>
          ))}
        </div>
      ) : (
        <section data-testid="project-list" className={CARD}>
          <div className={cx("hidden h-9 items-center gap-x-5 border-b border-border px-3.5 text-[12px] text-muted md:grid", COLUMNS)}>
            <span />
            <span>Project</span>
            <span>Latest deployment</span>
            <span className="hidden xl:block">Resources</span>
            <span>Status</span>
          </div>
          {shown.map(({ p, latest, live, host, state }) => {
            const isStatic = p.runtime.kind === "static";
            const u = usage.get(p.slug);
            return (
              <Link
                key={p.id}
                href={`/projects/${p.slug}`}
                className={cx("grid items-center gap-x-5 border-b border-border-soft px-3.5 py-2.5 transition-colors duration-150 last:border-b-0 hover:bg-hover", COLUMNS)}
              >
                <ProjectMark src={marks.get(p.slug)!} framework={p.framework} />
                <div className="grid min-w-0 gap-[3px]">
                  <b className="truncate font-bold">{p.slug}</b>
                  <span className={cx("truncate text-[12px]", live && host ? "text-muted" : "text-dim")}>{live && host ? host : "Not live yet"}</span>
                </div>
                <div className="hidden min-w-0 md:block">
                  <Commit project={p} latest={latest} />
                </div>
                <div className="hidden xl:block">
                  {isStatic ? (
                    <span className="text-[12px] text-muted">Served by Caddy</span>
                  ) : u && live ? (
                    <div className="grid gap-[7px]">
                      <Meter label="RAM" value={u.memoryMb === null ? "—" : `${u.memoryMb} MB`} fraction={(u.memoryMb ?? 0) / p.memoryMb} hot={(u.memoryMb ?? 0) / p.memoryMb > 0.75} />
                      <Meter label="CPU" value={u.cpu === null ? "—" : `${Math.round(u.cpu)}%`} fraction={(u.cpu ?? 0) / 100} hot={(u.cpu ?? 0) > 50} />
                    </div>
                  ) : (
                    <span className="text-[12px] text-muted">{live ? "No samples yet" : "Not running"}</span>
                  )}
                </div>
                <div className="grid min-w-0 justify-items-end gap-1 md:justify-items-start">
                  <StateWord state={state} />
                  <span className="max-w-full truncate text-[12px] text-muted max-sm:hidden">
                    {state === "failed" && live ? `Still serving ${live.sha.slice(0, 7)}` : `${servers.length ? `${serverName(p.serverId)} · ` : ""}${frameworkLabel(p.framework)} · ${isStatic ? "static" : `Node ${p.nodeVersion}`}`}
                  </span>
                </div>
              </Link>
            );
          })}
        </section>
      )}
    </>
  );
}

import { Add01Icon, Alert02Icon, CheckmarkCircle02Icon, DatabaseRestoreIcon, GitBranchIcon, Rocket01Icon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import type { ReactNode } from "react";
import { FilterBox, ServerButton } from "@/components/header-controls";
import { Icon, type IconSvgElement } from "@/components/icon";
import { Dot, Empty, Notice, PageHeader, PillLink, Section } from "@/components/page";
import { DeployStatusBadge, timeAgo } from "@/components/status";
import { Mark, StatusDot, cx } from "@/components/ui";
import { agent, type SystemInfo } from "@/lib/agent";
import { listIncidents } from "@/lib/alerts/engine";
import { listBackups } from "@/lib/backup/runner";
import { frameworkLabel } from "@/lib/detect";
import { FINISHED, listAllDeployments, listDeployments, liveDeployment } from "@/lib/deploy";
import { servingConfig } from "@/lib/domains";
import { listProjects } from "@/lib/projects";

export const dynamic = "force-dynamic";
export const metadata = { title: "Projects" };

const FW_DOT: Record<string, string> = {
  nextjs: "bg-foreground",
  vite: "bg-lavender",
  cra: "bg-lavender",
  "astro-node": "bg-coral",
  "astro-static": "bg-coral",
  "node-server": "bg-blue",
  nuxt: "bg-teal",
  remix: "bg-rose",
  "react-router": "bg-rose",
  "static-html": "bg-gold",
};

interface Activity {
  at: number;
  tone: "gold" | "ok" | "err" | "lav" | "coral";
  icon: IconSvgElement;
  text: ReactNode;
}

function activity(): Activity[] {
  const out: Activity[] = [];
  for (const d of listAllDeployments(12)) {
    if (d.status === "cancelled") continue;
    const commit = (
      <>
        <code className="font-mono text-[12.5px]">{d.sha.slice(0, 7)}</code> “{d.commitMessage || "deployment"}”
      </>
    );
    if (!FINISHED.includes(d.status))
      out.push({ at: d.createdAt, tone: "gold", icon: Rocket01Icon, text: <><b>{d.slug}</b> is deploying {commit}</> });
    else if (d.status === "ready")
      out.push({ at: d.finishedAt ?? d.createdAt, tone: "ok", icon: CheckmarkCircle02Icon, text: <><b>{d.slug}</b> is live with {commit}</> });
    else out.push({ at: d.finishedAt ?? d.createdAt, tone: "err", icon: Alert02Icon, text: <><b>{d.slug}</b> failed to deploy {commit}{d.error ? `: ${d.error}` : ""}</> });
  }
  for (const b of listBackups({ limit: 12 })) {
    if (b.status === "running") continue;
    const who = b.kind === "panel" ? "the panel" : b.slug;
    out.push(
      b.status === "ok"
        ? { at: Math.floor(b.startedAt / 1000), tone: "lav", icon: DatabaseRestoreIcon, text: <>Backed up <b>{who}</b></> }
        : { at: Math.floor(b.startedAt / 1000), tone: "err", icon: Alert02Icon, text: <><b>{who}</b> backup failed{b.error ? `: ${b.error}` : ""}</> },
    );
  }
  for (const i of listIncidents()) {
    out.push({ at: i.openedAt, tone: "coral", icon: Alert02Icon, text: i.title });
    if (i.resolvedAt) out.push({ at: i.resolvedAt, tone: "ok", icon: CheckmarkCircle02Icon, text: <>Resolved: {i.title}</> });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 8);
}

const ICON_TONE = { gold: "bg-gold/16 text-gold", ok: "bg-teal/16 text-teal", err: "bg-rose/16 text-rose", lav: "bg-lavender/16 text-lavender", coral: "bg-coral/16 text-coral" };

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
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
    return { p, latest, live, host, building, index: all.indexOf(p) };
  });
  const deploying = rows.find((r) => r.building);
  const feed = activity();

  return (
    <>
      <PageHeader
        title="Projects"
        actions={
          <>
            {info && (
              <ServerButton>
                <StatusDot status={info.caddy === "active" ? "ok" : "err"} />
                <b className="font-semibold text-foreground">{info.hostname}</b>
                <span className="hidden sm:inline">
                  <span className="text-dim">·</span> CPU {Math.round(((info.loadavg[0] ?? 0) / info.cpus) * 100)}% <span className="text-dim">·</span> RAM{" "}
                  {Math.round(((info.memoryMb.total - info.memoryMb.available) / info.memoryMb.total) * 100)}%
                </span>
              </ServerButton>
            )}
            <FilterBox placeholder="Filter projects" />
            <PillLink href="/new" primary>
              <Icon icon={Add01Icon} size={16} strokeWidth={2} /> New project
            </PillLink>
          </>
        }
      />
      {deploying?.latest && (
        <Notice lead="Building">
          {deploying.p.slug} is deploying <code className="font-mono text-[13px]">{deploying.latest.sha.slice(0, 7)}</code> “{deploying.latest.commitMessage || "deployment"}”, started {timeAgo(deploying.latest.createdAt)}.
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
          {rows.map(({ p, latest, live, host, building, index }) => {
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
                <Mark name={p.slug} index={index} />
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
                  <span className="inline-flex items-center gap-[7px] whitespace-nowrap text-[12.5px] text-dim max-sm:hidden">
                    <span className={cx("size-2 rounded-full", FW_DOT[p.framework] ?? "bg-dim")} />
                    {frameworkLabel(p.framework)} · {p.runtime.kind === "static" ? "static" : `Node ${p.nodeVersion}`}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {feed.length > 0 && (
        <Section
          title="Activity"
          description="Deploys, backups and alerts across the server."
          aside={
            <Link href="/deployments" className="text-[13px] text-lavender hover:underline">
              All deployments
            </Link>
          }
        >
          {feed.map((a, i) => (
            <div key={i} className="flex items-start gap-3.5 border-t border-border px-4 py-3.5 sm:px-7">
              <span className={cx("mt-px grid size-[30px] shrink-0 place-items-center rounded-full", ICON_TONE[a.tone])}>
                <Icon icon={a.icon} size={15} strokeWidth={2} />
              </span>
              <div className="min-w-0 flex-1 pt-1 text-[14.5px] leading-normal text-muted [&_b]:font-semibold [&_b]:text-foreground">{a.text}</div>
              <span className="whitespace-nowrap pt-[5px] text-[13px] text-dim">{timeAgo(a.at)}</span>
            </div>
          ))}
        </Section>
      )}
    </>
  );
}

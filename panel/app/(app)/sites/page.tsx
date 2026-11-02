import { ArrowUpRightIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { Icon } from "@/components/icon";
import { PageHeader, PillLink, Section, TableHead, TableRow } from "@/components/page";
import { StatusChip, timeAgo } from "@/components/status";
import { EngineTile } from "@/components/sites";
import { FINISHED, listDeployments, liveDeployment } from "@/lib/deploy";
import { servingConfig } from "@/lib/domains";
import type { Project } from "@/lib/projects";
import { requireUser } from "@/lib/session";
import { ENGINES, engineOf, getSite, listSites, type SiteEngine } from "@/lib/sites";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sites" };

const COLUMNS = "44px minmax(200px,1fr) 160px 120px auto";

function SiteRow({ project }: { project: Project }) {
  const engine = engineOf(project)!;
  const site = getSite(project.id);
  const latest = listDeployments(project.id, 1)[0];
  const live = liveDeployment(project.id);
  const version = listDeployments(project.id, 30).find((d) => d.version && d.status === "ready")?.version ?? null;
  const hosts = servingConfig(project.id).domains;
  const host = hosts.find((h) => h !== project.domains[0]) ?? hosts[0] ?? project.domains[0];
  const busy = latest && !FINISHED.includes(latest.status);
  const status = busy
    ? { dot: "warn" as const, label: latest.trigger === "install" ? "Installing" : latest.trigger === "update" ? "Updating" : "Deploying" }
    : live
      ? { dot: "ok" as const, label: "Live" }
      : latest?.status === "failed"
        ? { dot: "err" as const, label: latest.trigger === "install" ? "Install failed" : "Failed" }
        : { dot: "idle" as const, label: "Not running" };
  return (
    <TableRow columns={COLUMNS} data-testid={`site-${project.slug}`}>
      <EngineTile engine={engine} />
      <div className="grid min-w-0 flex-1 gap-px">
        <Link href={`/projects/${project.slug}/site`} className="truncate font-medium hover:underline">
          {site?.title ?? project.slug}
        </Link>
        <span className="truncate text-[12px] text-muted">{host}</span>
      </div>
      <div className="grid gap-px max-md:hidden">
        <span>
          {ENGINES[engine].name} {version ?? ""}
        </span>
        {live && <span className="text-[12px] text-muted">{timeAgo(live.finishedAt ?? live.createdAt)}</span>}
      </div>
      <span className="max-md:ml-auto">
        <StatusChip status={status.dot} label={status.label} pulse={!!busy} />
      </span>
      <span className="flex flex-wrap justify-end gap-2 max-md:w-full">
        {live && host && (
          <>
            <PillLink href={`https://${host}`} external size="sm">
              Open <Icon icon={ArrowUpRightIcon} size={13} />
            </PillLink>
            <PillLink href={`https://${host}${ENGINES[engine].adminPath}`} external size="sm">
              Admin <Icon icon={ArrowUpRightIcon} size={13} />
            </PillLink>
          </>
        )}
        <PillLink href={`/projects/${project.slug}/site`} size="sm">
          Manage
        </PillLink>
      </span>
    </TableRow>
  );
}

function EngineCard({ engine }: { engine: SiteEngine }) {
  return (
    <Link href={`/sites/new?engine=${engine}`} className="grid content-start gap-3 border border-border p-4 transition-colors duration-150 hover:border-accent" data-testid={`new-${engine}`}>
      <div className="flex items-center gap-3">
        <EngineTile engine={engine} />
        <b className="text-[15px]">{ENGINES[engine].name}</b>
      </div>
      <p className="text-[13px] text-muted">{ENGINES[engine].about}</p>
      <span className="text-[13px] text-accent">New {ENGINES[engine].name} site →</span>
    </Link>
  );
}

export default async function SitesPage() {
  await requireUser();
  const sites = listSites();
  return (
    <>
      <PageHeader
        title="Sites"
        meta="WordPress and Ghost, installed in one click, each sandboxed on its own"
        actions={
          <PillLink href="/sites/new" primary>
            <Icon icon={PlusIcon} size={16} strokeWidth={2} /> New site
          </PillLink>
        }
      />
      {sites.length > 0 && (
        <Section title="Your sites">
          <div className="border-t border-border" data-testid="site-list">
            <TableHead columns={COLUMNS}>
              <span />
              <span>Site</span>
              <span>Engine</span>
              <span>Status</span>
              <span />
            </TableHead>
            {sites.map((p) => (
              <SiteRow key={p.id} project={p} />
            ))}
          </div>
        </Section>
      )}
      <Section title={sites.length ? "Another site" : "Your first site"} description="Each site gets its own Linux user, sandbox, memory limit, database, address with HTTPS, and backups.">
        <div className="grid gap-3.5 px-3.5 pb-3.5 sm:grid-cols-2">
          <EngineCard engine="wordpress" />
          <EngineCard engine="ghost" />
        </div>
      </Section>
    </>
  );
}

import { ActivityIcon, ArrowUpRightIcon, CalendarIcon, ChartColumnIcon, ClipboardListIcon, ClockIcon, HandIcon, LinkIcon, MailIcon, MessageSquareIcon, PencilIcon, PuzzleIcon } from "lucide-react";
import Link from "next/link";
import { Icon, type IconSvgElement } from "@/components/icon";
import { CheckCatalogButton, InstallButton, UpdateButton } from "@/components/integrations";
import { Empty, Notice, PageHeader, PillLink, Section, TableHead, TableRow, TileIcon, type TileTone } from "@/components/page";
import { StatusChip, timeAgo } from "@/components/status";
import { Pill } from "@/components/ui";
import { catalogApps, updateFor, type CatalogApp } from "@/lib/catalog";
import { FINISHED, installedVersion, listDeployments, liveDeployment } from "@/lib/deploy";
import { servingConfig } from "@/lib/domains";
import { integrationFor, listProjects, type Project } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Integrations" };

/** Each app's square: its icon in a color of its own (a puzzle piece for apps this panel doesn't know yet). */
const LOOKS: Record<string, { icon: IconSvgElement; tone: TileTone }> = {
  hello: { icon: HandIcon, tone: "gold" },
  links: { icon: LinkIcon, tone: "lav" },
  analytics: { icon: ChartColumnIcon, tone: "blue" },
  email: { icon: MailIcon, tone: "coral" },
  forms: { icon: ClipboardListIcon, tone: "rose" },
  scheduler: { icon: CalendarIcon, tone: "blue" },
  blog: { icon: PencilIcon, tone: "teal" },
  status: { icon: ActivityIcon, tone: "teal" },
  waitlist: { icon: ClockIcon, tone: "gold" },
  feedback: { icon: MessageSquareIcon, tone: "coral" },
};

/** Planned: built for Self Host Layer, not in the catalog yet. */
const PLANNED = [
  { id: "links", name: "Links", what: "Short links on your own domain, with click stats and QR codes." },
  { id: "analytics", name: "Analytics", what: "Cookie-free web analytics for every project you deploy." },
  { id: "email", name: "Email marketing", what: "Newsletters and campaigns through your own SMTP or SES." },
  { id: "forms", name: "Forms", what: "Forms and surveys, one page or one question at a time, on your own address." },
  { id: "scheduler", name: "Post scheduler", what: "Schedule posts to X, LinkedIn and Threads." },
  { id: "blog", name: "Blog", what: "A fast blog with an editor, on your own domain." },
  { id: "status", name: "Status page", what: "A public uptime page fed by your apps' health checks." },
  { id: "waitlist", name: "Waitlist", what: "Collect sign-ups before launch and export them any time." },
  { id: "feedback", name: "Feedback board", what: "Let users suggest and vote on features." },
];

function Tile({ id }: { id: string | null }) {
  const look = (id && LOOKS[id]) || { icon: PuzzleIcon, tone: "dim" as const };
  return (
    <TileIcon tone={look.tone}>
      <Icon icon={look.icon} size={20} />
    </TileIcon>
  );
}

const INSTALLED = "44px minmax(200px,1fr) 150px 110px auto";
const CATALOG = "44px minmax(220px,1fr) 150px auto";
const PLANNED_COLUMNS = "44px minmax(220px,1fr) auto";

function InstalledRow({ project, app }: { project: Project; app: CatalogApp | undefined }) {
  const version = installedVersion(project.id);
  const update = updateFor(version?.version, app);
  const latest = listDeployments(project.id, 1)[0];
  const live = liveDeployment(project.id);
  const hosts = servingConfig(project.id).domains;
  // A custom domain (not the free URL) is the one to visit, once it's live.
  const host = hosts.find((h) => h !== project.domains[0]) ?? hosts[0] ?? project.domains[0];
  const busy = latest && !FINISHED.includes(latest.status);
  const status = busy
    ? { dot: "warn" as const, label: latest.trigger === "install" ? "Installing" : "Deploying" }
    : live
      ? { dot: "ok" as const, label: "Running" }
      : latest?.status === "failed"
        ? { dot: "err" as const, label: latest.trigger === "install" ? "Install failed" : "Failed" }
        : { dot: "idle" as const, label: "Not running" };
  return (
    <TableRow columns={INSTALLED} data-testid={`installed-${project.catalogApp}`}>
      <Tile id={project.catalogApp} />
      <div className="grid min-w-0 flex-1 gap-px">
        <Link href={`/projects/${project.slug}`} className="truncate font-medium hover:underline">
          {version?.manifest?.name ?? project.slug}
        </Link>
        <span className="truncate text-[12px] text-muted">{host}</span>
      </div>
      <div className="grid gap-px max-md:hidden">
        <span>{version?.version ?? "—"}</span>
        {version && <span className="text-[12px] text-muted">{timeAgo(version.finishedAt ?? version.createdAt)}</span>}
      </div>
      <span className="max-md:ml-auto">
        <StatusChip status={status.dot} label={status.label} pulse={!!busy} />
      </span>
      <span className="flex flex-wrap justify-end gap-2 max-md:w-full">
        {update && !busy && <UpdateButton slug={project.slug} version={update.version} />}
        {live && host && (
          <PillLink href={`https://${host}`} external size="sm">
            Open <Icon icon={ArrowUpRightIcon} size={13} />
          </PillLink>
        )}
        <PillLink href={`/projects/${project.slug}`} size="sm">
          Manage
        </PillLink>
      </span>
    </TableRow>
  );
}

function CatalogRow({ app }: { app: CatalogApp }) {
  const latest = app.versions[0]!;
  const installable = app.versions.find((v) => v.supported);
  const installed = integrationFor(app.id);
  return (
    <TableRow columns={CATALOG} data-testid={`catalog-${app.id}`}>
      <Tile id={app.id} />
      <div className="grid min-w-0 flex-1 gap-px">
        <span className="font-medium">{app.name}</span>
        <span className="text-[12px] text-muted">{app.summary}</span>
      </div>
      <div className="grid gap-px max-md:hidden">
        <span>{(installable ?? latest).version}</span>
        {(installable ?? latest).date && <span className="text-[12px] text-muted">{(installable ?? latest).date}</span>}
      </div>
      <span className="justify-self-end max-md:ml-auto">
        {installed ? (
          <PillLink href={`/projects/${installed.slug}`} size="sm">
            Manage
          </PillLink>
        ) : installable ? (
          <InstallButton app={app.id} />
        ) : (
          <Pill outline>Needs {latest.minPanel} or newer</Pill>
        )}
      </span>
    </TableRow>
  );
}

export default async function IntegrationsPage() {
  await requireUser();
  const installed = listProjects().filter((p) => p.source === "catalog");
  let apps: CatalogApp[] = [];
  let problem: string | null = null;
  try {
    apps = await catalogApps();
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err);
  }
  const listed = new Set(apps.map((a) => a.id));
  const planned = PLANNED.filter((p) => !listed.has(p.id));
  return (
    <>
      <PageHeader title="Integrations" meta="Tools every product needs, ready to install" />
      {problem && (
        <Notice lead="Offline" tone="err">
          Couldn&apos;t read the catalog: {problem}
        </Notice>
      )}
      {installed.length > 0 && (
        <Section title="Installed">
          <div className="border-t border-border">
            <TableHead columns={INSTALLED}>
              <span />
              <span>App</span>
              <span>Version</span>
              <span>Status</span>
              <span />
            </TableHead>
            {installed.map((p) => (
              <InstalledRow key={p.id} project={p} app={apps.find((a) => a.id === p.catalogApp)} />
            ))}
          </div>
        </Section>
      )}
      <Section title="Catalog" description="Every tool comes with Self Host Layer. Each runs as its own sandboxed app on this server." aside={<CheckCatalogButton />}>
        <div className="border-t border-border">
          {apps.length ? (
            <>
              <TableHead columns={CATALOG}>
                <span />
                <span>App</span>
                <span>Version</span>
                <span />
              </TableHead>
              {apps.map((a) => (
                <CatalogRow key={a.id} app={a} />
              ))}
            </>
          ) : (
            <Empty>{problem ? "The catalog shows here once it can be read." : "Nothing in the catalog yet."}</Empty>
          )}
        </div>
      </Section>
      {planned.length > 0 && (
        <Section title="Coming soon">
          <div className="border-t border-border">
            {planned.map((a) => (
              <TableRow key={a.id} columns={PLANNED_COLUMNS}>
                <Tile id={a.id} />
                <div className="grid min-w-0 flex-1 gap-px">
                  <span className="font-medium">{a.name}</span>
                  <span className="text-[12px] text-muted">{a.what}</span>
                </div>
                <span className="justify-self-end max-md:ml-auto">
                  <Pill outline>Coming soon</Pill>
                </span>
              </TableRow>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

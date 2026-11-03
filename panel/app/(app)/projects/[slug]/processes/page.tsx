import { PlayIcon, RotateCwIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { notFound } from "next/navigation";
import { controlWorkerAction, deleteWorkerAction } from "@/app/actions/workers";
import { Icon } from "@/components/icon";
import { CARD, Notice, PageHeader, SettingsRow, TableHead, TableRow } from "@/components/page";
import { RunCommand, WorkerForm } from "@/components/processes";
import { timeAgo } from "@/components/status";
import { StatusDot, cx } from "@/components/ui";
import { parseSystemdTime } from "@/lib/cron";
import { liveDeployment } from "@/lib/deploy";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";
import { hasProcesses, listWorkers, liveScripts, liveWorkers, type LiveWorker } from "@/lib/workers";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: `${(await params).slug} processes` };
}

const COLUMNS = "16px minmax(220px,1.6fr) 130px minmax(120px,1fr) 104px";
const iconButton = "grid size-8 place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground";

/** What a worker is doing, in a few words, and its dot. */
function describe(l: LiveWorker | undefined): { dot: "ok" | "warn" | "err" | "idle"; text: string; pulse?: boolean } {
  if (!l) return { dot: "idle", text: "Not on the server" };
  if (l.state === "active") {
    const since = parseSystemdTime(l.since);
    return { dot: "ok", text: `Running${since ? `, up ${timeAgo(since / 1000).replace(" ago", "")}` : ""}${l.restarts ? ` · ${l.restarts} restart${l.restarts === 1 ? "" : "s"}` : ""}` };
  }
  if (l.state === "activating") return { dot: "warn", text: `Restarting after exit ${l.exitStatus ?? "?"}`, pulse: true };
  // systemd gives up after 5 restarts in a minute; its Result stays the last exit's.
  if (l.state === "failed") return { dot: "err", text: l.restarts > 0 ? `Stopped: it kept exiting (code ${l.exitStatus ?? "?"})` : `Failed: exit code ${l.exitStatus ?? "?"}` };
  return { dot: "idle", text: "Stopped" };
}

const mb = (bytes: number | null) => (bytes === null ? null : `${Math.round(bytes / 2 ** 20)} MB`);

function ControlButton({ slug, name, action, label, icon }: { slug: string; name: string; action: string; label: string; icon: typeof PlayIcon }) {
  return (
    <form action={controlWorkerAction}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="name" value={name} />
      <input type="hidden" name="action" value={action} />
      <button type="submit" title={label} className={iconButton}>
        <Icon icon={icon} size={15} />
        <span className="sr-only">
          {label} {name}
        </span>
      </button>
    </form>
  );
}

export default async function ProcessesPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project || !hasProcesses(project)) notFound();
  const workers = listWorkers(project.id);
  const [live, scripts] = await Promise.all([liveWorkers(project.slug), liveScripts(project)]);
  const deployed = !!liveDeployment(project.id);

  return (
    <>
      <PageHeader title={project.slug} crumb="Processes" meta={<>workers and one-off commands · sandboxed like the app</>} />
      {!deployed && <Notice lead="Not deployed yet">Workers and commands run from the live release, so they start once the project has been deployed.</Notice>}

      {workers.length > 0 && (
        <section className={CARD} data-testid="worker-list">
          <TableHead columns={COLUMNS}>
            <span />
            <span>Worker</span>
            <span>Memory</span>
            <span>Status</span>
            <span />
          </TableHead>
          {workers.map((w) => {
            const l = live?.get(w.name);
            const d = live ? describe(l) : { dot: "idle" as const, text: "Couldn't ask the server" };
            const running = l?.state === "active" || l?.state === "activating";
            return (
              <TableRow key={w.id} columns={COLUMNS} data-testid="worker">
                <StatusDot status={d.dot} pulse={d.pulse} />
                <div className="grid min-w-0 gap-px">
                  <p className="truncate font-medium">{w.name}</p>
                  <p className="truncate text-[12px] text-muted">
                    <code className="font-mono">{w.command}</code>
                  </p>
                </div>
                <span className="truncate tabular-nums text-muted max-md:hidden">
                  {running && mb(l?.memoryBytes ?? null) ? `${mb(l!.memoryBytes)} of ` : ""}
                  {w.memoryMb < 1024 ? `${w.memoryMb} MB` : `${w.memoryMb / 1024} GB`}
                </span>
                <span className={cx("truncate", d.dot === "err" ? "text-rose" : "text-muted")} data-testid="worker-status">
                  {d.text}
                </span>
                <span className="flex justify-end gap-0.5">
                  {running ? (
                    <>
                      <ControlButton slug={project.slug} name={w.name} action="restart" label="Restart" icon={RotateCwIcon} />
                      <ControlButton slug={project.slug} name={w.name} action="stop" label="Stop" icon={SquareIcon} />
                    </>
                  ) : (
                    deployed && <ControlButton slug={project.slug} name={w.name} action="start" label="Start" icon={PlayIcon} />
                  )}
                  <form action={deleteWorkerAction}>
                    <input type="hidden" name="slug" value={project.slug} />
                    <input type="hidden" name="name" value={w.name} />
                    <button type="submit" title="Delete" className={iconButton}>
                      <Icon icon={Trash2Icon} size={15} />
                      <span className="sr-only">Delete {w.name}</span>
                    </button>
                  </form>
                </span>
              </TableRow>
            );
          })}
        </section>
      )}

      <SettingsRow
        title={workers.length ? "Add or update a worker" : "Add a worker"}
        description={
          <>
            A process that keeps running beside the app, like a queue consumer: same code, env vars, databases and sandbox. It restarts if it exits, and every deploy restarts it on the new
            release. Its output is on the Logs page. Saving with an existing name updates it.
          </>
        }
      >
        <WorkerForm slug={project.slug} nodeVersion={project.nodeVersion} />
      </SettingsRow>

      <SettingsRow
        title="Run a command"
        description={
          <>
            Runs once in the live release as the app, with its env vars, like a migration or a script. The output shows here as it runs. It stops when you press Stop, leave the page, or
            after an hour.
          </>
        }
      >
        <RunCommand slug={project.slug} suggestions={scripts} deployed={deployed} />
      </SettingsRow>
    </>
  );
}

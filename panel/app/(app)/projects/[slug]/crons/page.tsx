import { Delete02Icon, PlayIcon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteCronAction, runCronAction } from "@/app/actions/crons";
import { CronForm } from "@/components/crons";
import { Icon } from "@/components/icon";
import { Notice, PageHeader, SettingsRow, TableHead, TableRow } from "@/components/page";
import { timeAgo, timeIn } from "@/components/status";
import { StatusDot, cx } from "@/components/ui";
import { describeCron, parseSystemdTime } from "@/lib/cron";
import { listCrons, liveCrons } from "@/lib/crons";
import { liveDeployment } from "@/lib/deploy";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: `${(await params).slug} crons` };
}

const COLUMNS = "16px minmax(220px,1.4fr) minmax(140px,1fr) 110px 110px 72px";
const iconButton = "grid size-8 place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground";

export default async function CronsPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project) notFound();
  const crons = listCrons(project.id);
  const live = await liveCrons(project.slug);
  const deployed = !!liveDeployment(project.id);

  return (
    <>
      <PageHeader title={project.slug} crumb="Cron jobs" meta={<>systemd timers · sandboxed like the app</>} />
      {!deployed && <Notice lead="Not deployed yet">Jobs run from the live release, so they&apos;ll work once the project has been deployed.</Notice>}
      {crons.length > 0 && (
        <section className="border-b border-border" data-testid="cron-list">
          <TableHead columns={COLUMNS}>
            <span />
            <span>Job</span>
            <span>Schedule</span>
            <span>Last run</span>
            <span className="text-right">Next</span>
            <span />
          </TableHead>
          {crons.map((c) => {
            const l = live.get(c.name);
            const failed = !!l?.lastRun && !l.running && l.lastResult !== "success";
            const dot = !l?.lastRun ? "idle" : l.running ? "warn" : failed ? "err" : "ok";
            const last = parseSystemdTime(l?.lastRun ?? null);
            const next = parseSystemdTime(l?.nextRun ?? null);
            return (
              // A stretched link on the name, not a link around the row: the buttons can't live inside an <a>.
              <TableRow key={c.id} columns={COLUMNS} className="hover:bg-hover">
                <StatusDot status={dot} pulse={l?.running} />
                <Link href={`/projects/${project.slug}/crons/${c.name}`} className="grid min-w-0 flex-1 gap-px after:absolute after:inset-0">
                  <p className="truncate font-medium">{c.name}</p>
                  <p className="truncate text-[12.5px] text-muted">
                    <code className="font-mono">{c.command}</code>
                  </p>
                </Link>
                <span className="truncate text-muted max-md:hidden">{describeCron(c.schedule)}</span>
                <span className={cx("truncate max-md:hidden", failed ? "text-rose" : "text-muted")}>
                  {l?.running ? "Running now" : failed ? `Failed (${l?.lastExitStatus ?? "?"})` : last ? timeAgo(last / 1000) : l?.lastRun ? l.lastRun : "Never"}
                </span>
                {l?.nextRun ? (
                  <span className="truncate text-right tabular-nums text-muted max-md:ml-auto" title={l.nextRun} data-testid="next-run">
                    {next ? timeIn(next) : l.nextRun}
                  </span>
                ) : (
                  <span className="text-right text-dim max-md:ml-auto">Not scheduled</span>
                )}
                <span className="relative z-[1] flex justify-end gap-0.5">
                  <form action={runCronAction}>
                    <input type="hidden" name="slug" value={project.slug} />
                    <input type="hidden" name="name" value={c.name} />
                    <button type="submit" title="Run now" className={iconButton}>
                      <Icon icon={PlayIcon} size={15} />
                      <span className="sr-only">Run {c.name} now</span>
                    </button>
                  </form>
                  <form action={deleteCronAction}>
                    <input type="hidden" name="slug" value={project.slug} />
                    <input type="hidden" name="name" value={c.name} />
                    <button type="submit" title="Delete" className={iconButton}>
                      <Icon icon={Delete02Icon} size={15} />
                      <span className="sr-only">Delete {c.name}</span>
                    </button>
                  </form>
                </span>
              </TableRow>
            );
          })}
        </section>
      )}
      <SettingsRow
        title={crons.length ? "Add or update a job" : "Add a job"}
        description={
          <>
            Each job is a systemd timer on the server (<code className="font-mono text-[12px]">systemctl list-timers</code>). Saving a job with an existing name updates it.
          </>
        }
      >
        <CronForm slug={project.slug} nodeVersion={project.nodeVersion} />
      </SettingsRow>
    </>
  );
}

import { Play } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteCronAction, runCronAction } from "@/app/actions/crons";
import { CronForm } from "@/components/crons";
import { Card, StatusDot } from "@/components/ui";
import { describeCron } from "@/lib/cron";
import { listCrons, liveCrons } from "@/lib/crons";
import { liveDeployment } from "@/lib/deploy";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: `${(await params).slug} crons` };
}

export default async function CronsPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project) notFound();
  const crons = listCrons(project.id);
  const live = await liveCrons(project.slug);
  const deployed = !!liveDeployment(project.id);

  return (
    <div className="mx-auto grid max-w-[760px] gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Cron jobs</h1>
        <p className="text-muted">
          <Link href={`/projects/${project.slug}`} className="underline-offset-4 hover:underline">
            {project.slug}
          </Link>{" "}
          · each job is a systemd timer on the server (<code className="font-mono text-[12px]">systemctl list-timers</code>), sandboxed like the app.
        </p>
      </header>
      {!deployed && <Card className="p-4 text-[13px] text-muted">Jobs run from the live release, so they'll work once the project has been deployed.</Card>}
      {crons.length > 0 && (
        <Card className="divide-y divide-border overflow-hidden">
          {crons.map((c) => {
            const l = live.get(c.name);
            const dot = l?.running ? "warn" : l?.lastResult === "success" ? "ok" : l?.lastResult && l.lastRun ? "err" : "idle";
            return (
              <div key={c.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                <StatusDot status={dot} />
                <Link href={`/projects/${project.slug}/crons/${c.name}`} className="grid min-w-0 flex-1 gap-0.5">
                  <p className="font-medium">{c.name}</p>
                  <p className="truncate text-[12px] text-muted">
                    <code className="font-mono">{c.command}</code> · {describeCron(c.schedule)}
                  </p>
                </Link>
                <p className="hidden text-[12px] text-muted sm:block">{l?.running ? "Running now" : l?.nextRun ? `Next: ${l.nextRun}` : "Not scheduled"}</p>
                <div className="flex items-center gap-1">
                  <form action={runCronAction}>
                    <input type="hidden" name="slug" value={project.slug} />
                    <input type="hidden" name="name" value={c.name} />
                    <button type="submit" title="Run now" className="grid size-8 place-items-center rounded-md text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground">
                      <Play className="size-4" aria-hidden />
                      <span className="sr-only">Run {c.name} now</span>
                    </button>
                  </form>
                  <form action={deleteCronAction}>
                    <input type="hidden" name="slug" value={project.slug} />
                    <input type="hidden" name="name" value={c.name} />
                    <button type="submit" className="h-8 rounded-md px-3 text-[13px] text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground">
                      Delete
                    </button>
                  </form>
                </div>
              </div>
            );
          })}
        </Card>
      )}
      <Card className="p-5">
        <h2 className="mb-4 text-base font-semibold tracking-tight">{crons.length ? "Add or update a job" : "Add a cron job"}</h2>
        <CronForm slug={project.slug} nodeVersion={project.nodeVersion} />
      </Card>
    </div>
  );
}

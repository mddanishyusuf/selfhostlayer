import { notFound } from "next/navigation";
import { runCronAction } from "@/app/actions/crons";
import { SubmitButton } from "@/components/form";
import { CARD, Empty, PageHeader } from "@/components/page";
import { duration } from "@/components/status";
import { StatusDot, cx } from "@/components/ui";
import { describeCron } from "@/lib/cron";
import { cronHistory, getCron } from "@/lib/crons";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Cron runs" };

export default async function CronRunsPage({ params }: { params: Promise<{ slug: string; name: string }> }) {
  await requireUser();
  const { slug, name } = await params;
  const project = getProjectBySlug(slug);
  const cron = project ? getCron(project.id, name) : null;
  if (!project || !cron) notFound();
  const runs = await cronHistory(project.slug, cron.name, cron.createdAt).catch(() => []);

  return (
    <>
      <PageHeader
        back={`/projects/${project.slug}/crons`}
        title={project.slug}
        crumb={cron.name}
        meta={
          <>
            <code className="font-mono">{cron.command}</code> · {describeCron(cron.schedule)}
          </>
        }
        actions={
          <form action={runCronAction}>
            <input type="hidden" name="slug" value={project.slug} />
            <input type="hidden" name="name" value={cron.name} />
            <SubmitButton pending="Starting…" className="w-auto">
              Run now
            </SubmitButton>
          </form>
        }
      />
      <section className={CARD}>
        {runs.length === 0 && <Empty>No runs yet. Reload after a run starts.</Empty>}
        {runs.map((r, i) => (
          <details key={r.invocation} className="group border-b border-border last:border-b-0" open={i === 0}>
            <summary className="flex min-h-[56px] cursor-pointer list-none items-center gap-4 px-4 transition-colors duration-150 hover:bg-hover sm:px-6">
              <StatusDot status={r.status === "success" ? "ok" : r.status === "failed" ? "err" : "warn"} pulse={r.status === "running"} />
              <span className={cx("w-28 text-[14px] font-medium", r.status === "failed" && "text-rose")}>
                {r.status === "success" ? "Succeeded" : r.status === "failed" ? `Failed (${r.exitStatus ?? "?"})` : "Running"}
              </span>
              <span className="flex-1 text-[13.5px] tabular-nums text-muted">{new Date(r.startedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC</span>
              <span className="text-[13px] tabular-nums text-muted">{r.finishedAt ? duration(Math.max(0, Date.parse(r.finishedAt) - Date.parse(r.startedAt))) : "…"}</span>
            </summary>
            <pre className="mx-4 mb-4 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-code p-3.5 font-mono text-[12.5px] leading-relaxed text-[#ece8e3] sm:mx-7">
              {r.output.length ? r.output.join("\n") : "(no output)"}
            </pre>
          </details>
        ))}
      </section>
    </>
  );
}

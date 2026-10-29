import Link from "next/link";
import { notFound } from "next/navigation";
import { runCronAction } from "@/app/actions/crons";
import { SubmitButton } from "@/components/form";
import { duration } from "@/components/status";
import { Card, StatusDot } from "@/components/ui";
import { describeCron } from "@/lib/cron";
import { cronHistory, getCron } from "@/lib/crons";
import { getProjectBySlug } from "@/lib/projects";
import { PageBody, PageHeader } from "@/components/page";
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
        title={cron.name}
        back={`/projects/${project.slug}/crons`}
        subtitle={
          <>
            <code className="font-mono">{cron.command}</code> · {describeCron(cron.schedule)}
          </>
        }
        actions={
          <form action={runCronAction}>
            <input type="hidden" name="slug" value={project.slug} />
            <input type="hidden" name="name" value={cron.name} />
            <SubmitButton pending="Starting…" className="w-auto px-4">
              Run now
            </SubmitButton>
          </form>
        }
      />
      <PageBody>
      <Card className="divide-y divide-border overflow-hidden">
        {runs.length === 0 && <p className="px-5 py-8 text-center text-muted">No runs yet. Reload after a run starts.</p>}
        {runs.map((r) => (
          <details key={r.invocation} className="group" open={r === runs[0]}>
            <summary className="flex cursor-pointer list-none items-center gap-4 px-5 py-3.5 transition-colors duration-150 hover:bg-subtle">
              <StatusDot status={r.status === "success" ? "ok" : r.status === "failed" ? "err" : "warn"} />
              <span className="w-24 text-[13px] font-medium">{r.status === "success" ? "Succeeded" : r.status === "failed" ? `Failed (${r.exitStatus ?? "?"})` : "Running"}</span>
              <span className="flex-1 text-[13px] text-muted tabular-nums">{new Date(r.startedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC</span>
              <span className="text-[12px] text-muted tabular-nums">{r.finishedAt ? duration(Math.max(0, Date.parse(r.finishedAt) - Date.parse(r.startedAt))) : "…"}</span>
            </summary>
            <pre className="mx-5 mb-4 max-h-80 overflow-auto rounded-md bg-[#0a0a0a] p-3 font-mono text-[12px] leading-relaxed text-[#ededed] whitespace-pre-wrap">
              {r.output.length ? r.output.join("\n") : "(no output)"}
            </pre>
          </details>
        ))}
      </Card>
      </PageBody>
    </>
  );
}

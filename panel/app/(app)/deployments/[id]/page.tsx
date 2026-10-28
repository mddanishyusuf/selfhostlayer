import Link from "next/link";
import { notFound } from "next/navigation";
import { cancel } from "@/app/actions/projects";
import { LogViewer } from "@/components/deploy";
import { SubmitButton } from "@/components/form";
import { DeployStatusBadge, duration, timeAgo } from "@/components/status";
import { Card } from "@/components/ui";
import { FINISHED, getDeployment } from "@/lib/deploy";
import { getProject } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deployment" };

const STEP_LABEL = { fetch: "Fetch", install: "Install", build: "Build", start: "Start", switch: "Switch" } as const;

export default async function DeploymentPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const d = getDeployment(Number((await params).id));
  if (!d) notFound();
  const project = getProject(d.projectId);
  if (!project) notFound();
  const done = FINISHED.includes(d.status);

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <p className="text-[13px] text-muted">
            <Link href={`/projects/${project.slug}`} className="underline-offset-4 hover:underline">
              {project.slug}
            </Link>{" "}
            · deployment #{d.id} · {timeAgo(d.createdAt)}
          </p>
          <h1 className="text-xl font-semibold tracking-tight">{d.commitMessage || `Commit ${d.sha.slice(0, 7)}`}</h1>
          <p className="text-[13px] text-muted">
            <code className="font-mono">{d.sha.slice(0, 7)}</code> · {d.trigger}
            {d.commitAuthor && ` · ${d.commitAuthor}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <DeployStatusBadge status={d.status} />
          {!done && (
            <form action={cancel}>
              <input type="hidden" name="deploymentId" value={d.id} />
              <SubmitButton pending="Cancelling…" className="h-8 w-auto bg-transparent px-3 text-[13px] text-foreground ring-1 ring-border hover:bg-hover">
                Cancel
              </SubmitButton>
            </form>
          )}
        </div>
      </header>

      {d.error && (
        <Card className="border-err/40 p-4 text-[13px] text-err">
          {d.error} <span className="text-muted">The live version is unchanged.</span>
        </Card>
      )}

      {d.steps.length > 0 && (
        <ol className="flex flex-wrap gap-2">
          {d.steps.map((s, i) => (
            <li key={i} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-[13px]">
              <span className="font-medium">{STEP_LABEL[s.name]}</span>
              <span className="text-muted tabular-nums">{s.ms === null && done ? "-" : duration(s.ms)}</span>
            </li>
          ))}
        </ol>
      )}

      <LogViewer deploymentId={d.id} initialStatus={d.status} />
    </div>
  );
}

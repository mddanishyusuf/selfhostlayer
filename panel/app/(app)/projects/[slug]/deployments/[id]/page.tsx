import Link from "next/link";
import { notFound } from "next/navigation";
import { cancel } from "@/app/actions/projects";
import { LogViewer } from "@/components/deploy";
import { SubmitButton } from "@/components/form";
import { DeployStatusBadge, duration, timeAgo } from "@/components/status";
import { PageBody, PageHeader } from "@/components/page";
import { Card } from "@/components/ui";
import { FINISHED, getDeployment } from "@/lib/deploy";
import { getProject } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deployment" };

const STEP_LABEL = { fetch: "Fetch", install: "Install", build: "Build", start: "Start", switch: "Switch" } as const;

export default async function DeploymentPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  await requireUser();
  const { slug, id } = await params;
  const d = getDeployment(Number(id));
  if (!d) notFound();
  const project = getProject(d.projectId);
  if (!project || project.slug !== slug) notFound();
  const done = FINISHED.includes(d.status);

  return (
    <>
      <PageHeader
        back={`/projects/${project.slug}/deployments`}
        title={d.commitMessage || `Commit ${d.sha.slice(0, 7)}`}
        subtitle={
          <>
            <Link href={`/projects/${project.slug}`} className="font-bold text-foreground underline-offset-4 hover:underline">
              {project.slug}
            </Link>{" "}
            · #{d.id} · <code className="font-mono">{d.sha.slice(0, 7)}</code> · {d.trigger}
            {d.commitAuthor && ` · ${d.commitAuthor}`} · {timeAgo(d.createdAt)}
          </>
        }
        actions={
          <>
            <DeployStatusBadge status={d.status} />
            {!done && (
              <form action={cancel}>
                <input type="hidden" name="deploymentId" value={d.id} />
                <SubmitButton pending="Cancelling…" variant="secondary" className="h-8 w-auto px-3 text-[13px]">
                  Cancel
                </SubmitButton>
              </form>
            )}
          </>
        }
      />
      <PageBody className="gap-6">

      {d.error && (
        <Card className="border-err/40 p-4 text-[13px] text-err">
          {d.error} <span className="text-muted">The live version is unchanged.</span>
        </Card>
      )}

      {d.steps.length > 0 && (
        <ol className="flex flex-wrap gap-2">
          {d.steps.map((s, i) => (
            <li key={i} className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-[13px]">
              <span className="font-medium">{STEP_LABEL[s.name]}</span>
              <span className="text-muted tabular-nums">{s.ms === null && done ? "-" : duration(s.ms)}</span>
            </li>
          ))}
        </ol>
      )}

      <LogViewer deploymentId={d.id} initialStatus={d.status} />
      </PageBody>
    </>
  );
}

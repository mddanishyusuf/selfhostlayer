import { notFound } from "next/navigation";
import { redeploy } from "@/app/actions/projects";
import { DeploymentRows } from "@/components/deployment-rows";
import { SubmitButton } from "@/components/form";
import { PageBody, PageHeader } from "@/components/page";
import { listDeployments, liveDeployment } from "@/lib/deploy";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deployments" };

export default async function ProjectDeploymentsPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project) notFound();
  const live = liveDeployment(project.id);
  return (
    <>
      <PageHeader
        title="Deployments"
        subtitle={project.slug}
        actions={
          <form action={redeploy}>
            <input type="hidden" name="slug" value={project.slug} />
            <SubmitButton pending="Starting…" className="w-auto">
              Redeploy
            </SubmitButton>
          </form>
        }
      />
      <PageBody>
        <p className="text-[13px] text-muted">Roll back to any earlier ready deployment instantly: its build is still on disk.</p>
        <DeploymentRows slug={project.slug} deployments={listDeployments(project.id, 100)} liveIds={live ? [live.id] : []} rollbacks />
      </PageBody>
    </>
  );
}

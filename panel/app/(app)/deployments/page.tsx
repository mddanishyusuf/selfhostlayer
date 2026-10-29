import { DeploymentRows } from "@/components/deployment-rows";
import { PageBody, PageHeader } from "@/components/page";
import { listAllDeployments, liveDeployment } from "@/lib/deploy";
import { listProjects } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deployments" };

export default async function AllDeploymentsPage() {
  await requireUser();
  const deployments = listAllDeployments(100);
  const liveIds = listProjects()
    .map((p) => liveDeployment(p.id)?.id)
    .filter((id): id is number => id !== undefined);
  return (
    <>
      <PageHeader title="Deployments" subtitle="Every project, newest first" />
      <PageBody>
        <DeploymentRows deployments={deployments} liveIds={liveIds} showProject empty="No deployments yet. Create a project to deploy your first app." />
      </PageBody>
    </>
  );
}

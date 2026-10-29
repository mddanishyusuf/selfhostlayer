import { notFound, redirect } from "next/navigation";
import { getDeployment } from "@/lib/deploy";
import { getProject } from "@/lib/projects";
import { requireUser } from "@/lib/session";

/** Old links (alerts already sent, bookmarks): deployments now live under their project. */
export default async function DeploymentRedirect({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const d = getDeployment(Number((await params).id));
  const project = d ? getProject(d.projectId) : null;
  if (!d || !project) notFound();
  redirect(`/projects/${project.slug}/deployments/${d.id}`);
}

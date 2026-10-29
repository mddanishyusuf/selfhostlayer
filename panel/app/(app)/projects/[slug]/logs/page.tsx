import { notFound } from "next/navigation";
import { AppLogs } from "@/components/deploy";
import { Empty, PageHeader } from "@/components/page";
import { liveDeployment, listDeployments, deploymentPath } from "@/lib/deploy";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Logs" };

export default async function LogsPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project) notFound();
  const latest = listDeployments(project.id, 1)[0];
  return (
    <>
      <PageHeader
        title={project.slug}
        crumb="Logs"
        meta={<code className="font-mono">journalctl -u &apos;app-{project.slug}@*&apos;</code>}
        actions={
          latest && (
            <a href={deploymentPath(project.slug, latest.id)} className="text-[13px] text-lavender hover:underline">
              Latest build log
            </a>
          )
        }
      />
      {project.runtime.kind === "static" ? (
        <Empty>Static sites have no process, so there are no app logs. Caddy serves the files.</Empty>
      ) : !liveDeployment(project.id) ? (
        <Empty>Nothing is running yet. Logs appear here once the first deploy is live.</Empty>
      ) : (
        <AppLogs slug={project.slug} />
      )}
    </>
  );
}

import { DeploymentRows } from "@/components/deployment-rows";
import { Notice, PageHeader, Tabs } from "@/components/page";
import { timeAgo } from "@/components/status";
import { FINISHED, listAllDeployments, liveDeployment } from "@/lib/deploy";
import { listProjects } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deployments" };

export default async function AllDeploymentsPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  await requireUser();
  const filter = (await searchParams).f ?? "all";
  const all = listAllDeployments(100);
  const liveIds = listProjects()
    .map((p) => liveDeployment(p.id)?.id)
    .filter((id): id is number => id !== undefined);
  const shown = all.filter((d) => (filter === "live" ? liveIds.includes(d.id) : filter === "failed" ? d.status === "failed" : true));
  const building = all.find((d) => !FINISHED.includes(d.status));
  return (
    <>
      <PageHeader title="Deployments" meta="All projects, newest first" />
      {building && (
        <Notice lead="Building">
          {building.slug} is deploying <code className="font-mono text-[13px]">{building.sha.slice(0, 7)}</code> “{building.commitMessage || "deployment"}”, started {timeAgo(building.createdAt)}.
        </Notice>
      )}
      <Tabs
        items={[
          { href: "/deployments", label: "All", count: all.length, active: filter === "all" },
          { href: "/deployments?f=live", label: "Live", count: liveIds.length, active: filter === "live" },
          { href: "/deployments?f=failed", label: "Failed", count: all.filter((d) => d.status === "failed").length, active: filter === "failed" },
        ]}
      />
      <DeploymentRows deployments={shown} liveIds={liveIds} showProject empty={filter === "all" ? "No deployments yet. Create a project to deploy your first app." : "Nothing here."} />
    </>
  );
}

import { RightRail } from "@/components/shell/right-rail";
import { Sidebar, type SidebarProject } from "@/components/shell/sidebar";
import { listIncidents } from "@/lib/alerts/engine";
import { boxConfig } from "@/lib/box";
import { listDeployments, liveDeployment } from "@/lib/deploy";
import { servingConfig } from "@/lib/domains";
import { listProjects } from "@/lib/projects";
import { requireUser } from "@/lib/session";

function sidebarProjects(): SidebarProject[] {
  return listProjects().map((p) => {
    const latest = listDeployments(p.id, 1)[0];
    const live = liveDeployment(p.id);
    const building = latest && !["ready", "failed", "cancelled"].includes(latest.status);
    const hosts = servingConfig(p.id).domains;
    // A custom domain (not the free URL) is the one to visit, once it's live.
    const host = hosts.find((h) => h !== p.domains[0]) ?? hosts[0] ?? p.domains[0];
    return {
      slug: p.slug,
      repo: `${p.repoOwner}/${p.repoName}`,
      status: building ? "warn" : live ? "ok" : latest?.status === "failed" ? "err" : "idle",
      isStatic: p.runtime.kind === "static",
      url: live && host ? `https://${host}` : null,
    };
  });
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const openIncidents = listIncidents().filter((i) => !i.resolvedAt).length;
  let server = "this server";
  try {
    server = boxConfig().panelHost;
  } catch {
    // dev: no box config
  }
  return (
    <div className="mx-auto flex min-h-dvh max-w-[1340px] justify-center">
      <Sidebar projects={sidebarProjects()} openIncidents={openIncidents} email={user.email} server={server} />
      <main className="min-h-dvh min-w-0 max-w-[820px] flex-1 border-border pt-14 md:border-x md:pt-0">{children}</main>
      <RightRail />
    </div>
  );
}

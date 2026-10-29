import { cookies } from "next/headers";
import { CommandPalette, type PaletteItem } from "@/components/shell/palette";
import { ServerModal } from "@/components/shell/server-modal";
import { Sidebar, type SidebarProject } from "@/components/shell/sidebar";
import { agent, type SystemInfo } from "@/lib/agent";
import { listIncidents } from "@/lib/alerts/engine";
import { boxConfig } from "@/lib/box";
import { listDeployments, liveDeployment } from "@/lib/deploy";
import { listAllDomains, servingConfig } from "@/lib/domains";
import { listProjects } from "@/lib/projects";
import { requireUser } from "@/lib/session";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";

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
      branch: p.branch,
      status: building ? "warn" : live ? "ok" : latest?.status === "failed" ? "err" : "idle",
      isStatic: p.runtime.kind === "static",
      url: live && host ? `https://${host}` : null,
    };
  });
}

const PAGES: PaletteItem[] = [
  { label: "Projects", href: "/", hint: "Page" },
  { label: "Deployments", href: "/deployments", hint: "Page" },
  { label: "Analytics", href: "/analytics", hint: "Page" },
  { label: "Firewall", href: "/firewall", hint: "Page" },
  { label: "Domains", href: "/domains", hint: "Page" },
  { label: "Integrations", href: "/integrations", hint: "Page" },
  { label: "Databases", href: "/databases", hint: "Page" },
  { label: "Backups", href: "/settings/backups", hint: "Page" },
  { label: "Alerts", href: "/settings/alerts", hint: "Page" },
  { label: "Settings", href: "/settings", hint: "Page" },
  { label: "New project", href: "/new", hint: "Action" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const projects = sidebarProjects();
  let host = "this server";
  try {
    host = boxConfig().panelHost;
  } catch {
    // dev: no box config
  }
  // The server's name and size for the sidebar; quick (the agent answers locally).
  const info = await agent<SystemInfo>("system.info").catch(() => null);
  const spec = info ? `${info.cpus} vCPU · ${Math.round(info.memoryMb.total / 1024)} GB · ${info.os.name.replace(/ LTS$/, "")}` : "agent not reachable";
  const items: PaletteItem[] = [
    ...PAGES,
    ...listProjects().flatMap((p) => [
      { label: p.slug, href: `/projects/${p.slug}`, hint: servingConfig(p.id).domains.find((h) => h !== p.domains[0]) ?? servingConfig(p.id).domains[0] ?? "Project" },
      { label: `${p.slug}: deployments`, href: `/projects/${p.slug}/deployments`, hint: "Project" },
      { label: `${p.slug}: environment`, href: `/projects/${p.slug}/env`, hint: "Project" },
    ]),
  ];
  return (
    <div className="flex min-h-dvh">
      <Sidebar
        projects={projects}
        domainCount={listAllDomains().length}
        deploying={projects.some((p) => p.status === "warn")}
        openIncidents={listIncidents().filter((i) => !i.resolvedAt).length}
        email={user.email}
        server={{ name: info?.hostname ?? "Server", spec, host }}
        theme={parseTheme((await cookies()).get(THEME_COOKIE)?.value)}
      />
      <main className="min-h-dvh min-w-0 flex-1 pt-14 md:pt-0">{children}</main>
      <ServerModal name={info?.hostname ?? "Server"} />
      <CommandPalette items={items} />
    </div>
  );
}

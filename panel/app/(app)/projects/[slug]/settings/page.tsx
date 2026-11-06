import { notFound } from "next/navigation";
import { DeleteProject, SiteSettingsForm, SettingsForm } from "@/components/settings";
import { Notice, PageHeader, SettingsRow } from "@/components/page";
import { frameworkLabel } from "@/lib/detect";
import { listDeployments } from "@/lib/deploy";
import { getProjectBySlug, projectEnv } from "@/lib/projects";
import { movedFrom } from "@/lib/move";
import { listServers } from "@/lib/servers";
import { requireUser } from "@/lib/session";
import { MoveProject } from "@/components/servers";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: `${(await params).slug} settings` };
}

export default async function SettingsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ new?: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project) notFound();
  if (project.source === "site") {
    // A site's engine decides how it runs (its page is WordPress or Ghost); its memory limit is the owner's.
    const name = project.catalogApp === "ghost" ? "Ghost" : "WordPress";
    return (
      <>
        <PageHeader title={project.slug} crumb="Settings" meta={`A ${name} site`} />
        <SiteSettingsForm slug={project.slug} name={project.slug} memoryMb={project.memoryMb} min={project.catalogApp === "ghost" ? 384 : 128} />
        <DeleteProject slug={project.slug} />
      </>
    );
  }
  const isNew = (await searchParams).new === "1" && listDeployments(project.id, 1).length === 0;
  const servers = listServers();
  const serverName = (id: number | null) => (id === null ? "This server" : (servers.find((x) => x.id === id)?.name ?? "another server"));
  const moved = movedFrom(project.id);
  const r = project.runtime;

  return (
    <>
      <PageHeader
        title={isNew ? `Configure ${project.slug}` : project.slug}
        crumb={isNew ? undefined : "Settings"}
        back={isNew ? "/" : undefined}
        meta={`${frameworkLabel(project.framework)} detected`}
      />
      {isNew && (
        <Notice lead="Almost live" tone="lav">
          Check what we detected, add the env vars it needs, then deploy. It will be live at <b className="font-medium text-foreground">{project.domains[0]}</b>.
        </Notice>
      )}
      <SettingsForm
        isNew={isNew}
        framework={frameworkLabel(project.framework)}
        d={{
          slug: project.slug,
          repo: `${project.repoOwner}/${project.repoName}${project.rootDir ? ` · ${project.rootDir}` : ""}`,
          branch: project.branch,
          installCommand: project.installCommand ?? "",
          buildCommand: project.buildCommand ?? "",
          runtime: r.kind === "static" ? "static" : "node",
          startCommand: r.kind === "node" ? r.exec.join(" ") : "node server.js",
          healthPath: r.kind === "node" ? r.healthPath : "/",
          writablePaths: r.kind === "node" ? r.writablePaths.join(", ") : "",
          outputDir: r.kind === "static" ? r.outputDir : "dist",
          spa: r.kind === "static" ? r.spa : true,
          nodeVersion: project.nodeVersion,
          memoryMb: project.memoryMb,
          packageManager: project.packageManager,
          env: Object.entries(projectEnv(project.id)),
        }}
      />
      {!isNew && servers.length > 0 && (
        <SettingsRow title="Server" description={`It runs on ${serverName(project.serverId)}. Moving it builds it on the other server, copies its data (files and databases) there and moves its free address; its own domains wait for DNS to point at the new server. The old copy keeps running until you remove it.`}>
          <MoveProject slug={project.slug} current={serverName(project.serverId)} servers={[{ value: "here", name: "This server" }, ...servers.filter((x) => x.seenAt).map((x) => ({ value: String(x.id), name: x.name }))]} oldCopy={moved === undefined ? null : serverName(moved)} />
        </SettingsRow>
      )}
      {!isNew && <DeleteProject slug={project.slug} />}
    </>
  );
}

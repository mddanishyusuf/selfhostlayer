import { notFound } from "next/navigation";
import { DeleteProject, IntegrationSettingsForm, SettingsForm } from "@/components/settings";
import { Notice, PageHeader } from "@/components/page";
import { frameworkLabel } from "@/lib/detect";
import { installedVersion, listDeployments } from "@/lib/deploy";
import { getProjectBySlug, projectEnv } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: `${(await params).slug} settings` };
}

export default async function SettingsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ new?: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project) notFound();
  if (project.source === "catalog") {
    // An integration's manifest decides how it builds and runs; its memory limit is the owner's.
    const version = installedVersion(project.id);
    const name = version?.manifest?.name ?? project.slug;
    return (
      <>
        <PageHeader title={project.slug} crumb="Settings" meta={`${version?.commitMessage ?? name}, from the catalog`} />
        <IntegrationSettingsForm slug={project.slug} name={name} memoryMb={project.memoryMb} min={version?.manifest?.memory.min ?? 64} />
        <DeleteProject slug={project.slug} integration={name} />
      </>
    );
  }
  const isNew = (await searchParams).new === "1" && listDeployments(project.id, 1).length === 0;
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
          runtime: r.kind,
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
      {!isNew && <DeleteProject slug={project.slug} />}
    </>
  );
}

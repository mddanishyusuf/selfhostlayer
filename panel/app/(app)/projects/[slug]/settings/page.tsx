import Link from "next/link";
import { notFound } from "next/navigation";
import { DeleteProject, SettingsForm } from "@/components/settings";
import { frameworkLabel } from "@/lib/detect";
import { listDeployments } from "@/lib/deploy";
import { getProjectBySlug, projectEnv } from "@/lib/projects";
import { PageBody, PageHeader } from "@/components/page";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: `${(await params).slug} settings` };
}

export default async function SettingsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ new?: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project) notFound();
  const isNew = (await searchParams).new === "1" && listDeployments(project.id, 1).length === 0;
  const r = project.runtime;

  return (
    <>
      <PageHeader
        title={isNew ? `Configure ${project.slug}` : "Settings"}
        back={isNew ? "/" : undefined}
        subtitle={
          <>
            <Link href={`/projects/${project.slug}`} className="underline-offset-4 hover:underline">
            {project.repoOwner}/{project.repoName}
          </Link>
          {project.rootDir && ` · ${project.rootDir}`} · will be live at <span className="text-foreground">{project.domains[0]}</span>
          </>
        }
      />
      <PageBody>
      <SettingsForm
        isNew={isNew}
        framework={frameworkLabel(project.framework)}
        d={{
          slug: project.slug,
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
      </PageBody>
    </>
  );
}

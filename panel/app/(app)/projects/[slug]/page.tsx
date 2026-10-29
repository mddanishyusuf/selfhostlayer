import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { redeploy } from "@/app/actions/projects";
import { DeploymentRows } from "@/components/deployment-rows";
import { SubmitButton } from "@/components/form";
import { PageBody, PageHeader, PillLink, Section } from "@/components/page";
import { DeployStatusBadge } from "@/components/status";
import { frameworkLabel } from "@/lib/detect";
import { listDeployments, liveDeployment } from "@/lib/deploy";
import { servingConfig } from "@/lib/domains";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: (await params).slug };
}

export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project) notFound();
  const deployments = listDeployments(project.id, 5);
  const live = liveDeployment(project.id);
  const serving = servingConfig(project.id);
  const hosts = serving.domains.length ? serving.domains : project.domains;
  // A custom domain (not the free URL) is the one to visit, once it's live.
  const url = `https://${hosts.find((h) => h !== project.domains[0]) ?? hosts[0]}`;

  return (
    <>
      <PageHeader
        title={project.slug}
        subtitle={
          <a href={`https://github.com/${project.repoOwner}/${project.repoName}`} className="underline-offset-4 hover:underline">
            {project.repoOwner}/{project.repoName}
            {project.rootDir && ` · ${project.rootDir}`} · {project.branch}
          </a>
        }
        actions={
          <>
            <PillLink href={url} external>
              Visit <ArrowUpRight className="size-3.5" aria-hidden />
            </PillLink>
            <form action={redeploy}>
              <input type="hidden" name="slug" value={project.slug} />
              <SubmitButton pending="Starting…" className="w-auto">
                Redeploy
              </SubmitButton>
            </form>
          </>
        }
      />
      <PageBody>
        <div className="grid divide-y divide-border rounded-2xl border border-border sm:grid-cols-[1fr_2fr_1.3fr] sm:divide-x sm:divide-y-0">
          <div className="grid content-start gap-1.5 px-4 py-4">
            <p className="text-[13px] text-muted">Status</p>
            {live ? <DeployStatusBadge status="ready" /> : deployments[0] ? <DeployStatusBadge status={deployments[0].status} /> : <span>Not deployed</span>}
          </div>
          <div className="grid min-w-0 content-start gap-1.5 px-4 py-4">
            <p className="text-[13px] text-muted">Domains</p>
            {hosts.map((d) => (
              <a key={d} href={`https://${d}`} className="truncate text-[15px] font-bold underline-offset-4 hover:underline">
                {d}
              </a>
            ))}
          </div>
          <div className="grid content-start gap-1.5 px-4 py-4">
            <p className="text-[13px] text-muted">Runtime</p>
            <p className="text-[15px] font-bold">
              {frameworkLabel(project.framework)} · {project.runtime.kind === "static" ? "static" : `Node ${project.nodeVersion}`}
            </p>
          </div>
        </div>

        <Section
          title="Recent deployments"
          aside={
            <Link href={`/projects/${project.slug}/deployments`} className="text-[14px] text-accent hover:underline">
              Show all
            </Link>
          }
        >
          <DeploymentRows slug={project.slug} deployments={deployments} liveIds={live ? [live.id] : []} rollbacks />
        </Section>
      </PageBody>
    </>
  );
}

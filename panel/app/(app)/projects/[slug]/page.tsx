import { ArrowUpRight, RotateCcw } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { redeploy, rollback } from "@/app/actions/projects";
import { SubmitButton } from "@/components/form";
import { DeployStatusBadge, timeAgo } from "@/components/status";
import { Card } from "@/components/ui";
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
  const deployments = listDeployments(project.id);
  const live = liveDeployment(project.id);
  const serving = servingConfig(project.id);
  const hosts = serving.domains.length ? serving.domains : project.domains;
  // A custom domain (not the free URL) is the one to visit, once it's live.
  const url = `https://${hosts.find((h) => h !== project.domains[0]) ?? hosts[0]}`;

  return (
    <div className="grid gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{project.slug}</h1>
          <p className="text-muted">
            <a href={`https://github.com/${project.repoOwner}/${project.repoName}`} className="underline-offset-4 hover:underline">
              {project.repoOwner}/{project.repoName}
            </a>
            {project.rootDir && ` · ${project.rootDir}`} · {project.branch}
          </p>
        </div>
        <div className="flex gap-2">
          <form action={redeploy}>
            <input type="hidden" name="slug" value={project.slug} />
            <SubmitButton pending="Starting…" className="h-9 w-auto px-4">
              Redeploy
            </SubmitButton>
          </form>
          <Link href={`/projects/${project.slug}/crons`} className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium transition-colors duration-150 hover:bg-hover">
            Crons
          </Link>
          <Link href={`/projects/${project.slug}/domains`} className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium transition-colors duration-150 hover:bg-hover">
            Domains
          </Link>
          <Link href={`/projects/${project.slug}/settings`} className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium transition-colors duration-150 hover:bg-hover">
            Settings
          </Link>
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-4 text-sm font-medium transition-colors duration-150 hover:bg-hover">
            Visit <ArrowUpRight className="size-3.5" aria-hidden />
          </a>
        </div>
      </header>

      <Card className="grid gap-4 p-5 sm:grid-cols-4">
        <div className="grid gap-1">
          <p className="text-[13px] text-muted">Status</p>
          {live ? <DeployStatusBadge status="ready" /> : deployments[0] ? <DeployStatusBadge status={deployments[0].status} /> : <span>Not deployed</span>}
        </div>
        <div className="grid gap-1 sm:col-span-2">
          <p className="text-[13px] text-muted">Domains</p>
          {hosts.map((d) => (
            <a key={d} href={`https://${d}`} className="truncate font-medium underline-offset-4 hover:underline">
              {d}
            </a>
          ))}
        </div>
        <div className="grid gap-1">
          <p className="text-[13px] text-muted">Runtime</p>
          <p className="font-medium">
            {frameworkLabel(project.framework)} · {project.runtime.kind === "static" ? "static" : `Node ${project.nodeVersion}`}
          </p>
        </div>
      </Card>

      <section className="grid gap-3">
        <h2 className="text-base font-semibold tracking-tight">Deployments</h2>
        <Card className="divide-y divide-border overflow-hidden">
          {deployments.length === 0 && <p className="px-5 py-8 text-center text-muted">No deployments yet.</p>}
          {deployments.map((d) => (
            <div key={d.id} className="flex items-center gap-4 px-5 py-3.5 transition-colors duration-150 hover:bg-subtle">
              <div className="w-28 shrink-0">
                <DeployStatusBadge status={d.status} />
              </div>
              <Link href={`/deployments/${d.id}`} className="grid min-w-0 flex-1 gap-0.5">
                <p className="truncate font-medium">{d.commitMessage || "Deployment"}</p>
                <p className="text-[12px] text-muted">
                  <code className="font-mono">{d.sha.slice(0, 7)}</code> · {d.trigger}
                  {live?.id === d.id && <span className="text-ok"> · live</span>}
                </p>
              </Link>
              <p className="hidden text-[12px] text-muted tabular-nums sm:block">{timeAgo(d.createdAt)}</p>
              {d.status === "ready" && live?.id !== d.id ? (
                <form action={rollback}>
                  <input type="hidden" name="deploymentId" value={d.id} />
                  <button type="submit" title="Roll back to this deployment" className="grid size-8 place-items-center rounded-md text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground">
                    <RotateCcw className="size-4" aria-hidden />
                    <span className="sr-only">Roll back to this deployment</span>
                  </button>
                </form>
              ) : (
                <span className="size-8" aria-hidden />
              )}
            </div>
          ))}
        </Card>
      </section>
    </div>
  );
}

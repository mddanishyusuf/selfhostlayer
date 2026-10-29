import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { redeploy } from "@/app/actions/projects";
import { DeploymentRows } from "@/components/deployment-rows";
import { SubmitButton } from "@/components/form";
import { Icon } from "@/components/icon";
import { KeyValues, Notice, PageHeader, PillLink, Section, Stats } from "@/components/page";
import { SitePreviewFrame, SitePreviewSkeleton } from "@/components/site-preview";
import { DeployStatusBadge, duration, timeAgo } from "@/components/status";
import { agent } from "@/lib/agent";
import { frameworkLabel } from "@/lib/detect";
import { FINISHED, listDeployments, liveDeployment } from "@/lib/deploy";
import { servingConfig } from "@/lib/domains";
import { getProjectBySlug, listProjects } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: (await params).slug };
}

interface UnitStatus {
  live: "blue" | "green" | null;
  blue?: { memoryMb: number | null; port: number | null; restarts: number };
  green?: { memoryMb: number | null; port: number | null; restarts: number };
}

export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project) notFound();
  const deployments = listDeployments(project.id, 5);
  const latest = deployments[0];
  const live = liveDeployment(project.id);
  const serving = servingConfig(project.id);
  const hosts = serving.domains.length ? serving.domains : project.domains;
  // A custom domain (not the free URL) is the one to visit, once it's live.
  const url = `https://${hosts.find((h) => h !== project.domains[0]) ?? hosts[0]}`;
  const isStatic = project.runtime.kind === "static";
  const [unit, score] = isStatic
    ? [null, null]
    : await Promise.all([
        agent<UnitStatus>("unit.status", { slug: project.slug }).catch(() => null),
        live ? agent<{ score: number; rating: string }>("security.score", { slug: project.slug, color: live.color === "green" ? "green" : "blue" }).catch(() => null) : null,
      ]);
  const color = unit?.live ? unit[unit.live] : undefined;
  const building = latest && !FINISHED.includes(latest.status) ? latest : null;

  return (
    <>
      <PageHeader
        title={project.slug}
        crumb="Overview"
        meta={`${project.repoOwner}/${project.repoName}`}
        actions={
          <>
            {live && (
              <PillLink href={url} external>
                Visit <Icon icon={ArrowUpRight01Icon} size={14} />
              </PillLink>
            )}
            <form action={redeploy}>
              <input type="hidden" name="slug" value={project.slug} />
              <SubmitButton pending="Starting…" className="w-auto">
                Redeploy
              </SubmitButton>
            </form>
          </>
        }
      />
      {building ? (
        <Notice lead="Building">
          <code className="font-mono text-[13px]">{building.sha.slice(0, 7)}</code> “{building.commitMessage || "deployment"}”. The live version keeps serving until it&apos;s ready.
        </Notice>
      ) : latest?.status === "failed" ? (
        <Notice lead="Failed" tone="err">
          The last deploy failed{latest.error ? ` (${latest.error})` : ""}. {live ? "The live version is unchanged." : "Nothing is live yet."}
        </Notice>
      ) : live ? (
        <Notice lead="Live" tone="ok">
          <code className="font-mono text-[13px]">{live.sha.slice(0, 7)}</code> “{live.commitMessage || "deployment"}”, deployed {timeAgo(live.finishedAt ?? live.createdAt)} by {live.trigger}.
        </Notice>
      ) : null}

      <Stats
        items={[
          {
            label: "Status",
            value: <span className="text-[17px]">{live ? <DeployStatusBadge status="ready" /> : latest ? <DeployStatusBadge status={latest.status} /> : "Not deployed"}</span>,
            detail: isStatic ? "Served by Caddy" : unit?.live ? `${unit.live} · port ${color?.port ?? "?"}` : "Not running",
          },
          { label: "Runtime", value: <span className="text-[17px]">{frameworkLabel(project.framework)}</span>, detail: isStatic ? "Static files" : `Node ${project.nodeVersion}` },
          ...(isStatic
            ? []
            : [
                { label: "Memory", value: color?.memoryMb != null ? `${color.memoryMb} MB` : "—", small: `of ${project.memoryMb}`, detail: color ? `${color.restarts} restart${color.restarts === 1 ? "" : "s"}` : "No process" },
                { label: "Sandbox", value: score ? String(score.score) : "—", small: score ? "exposure" : undefined, detail: "systemd-analyze security (0 is safest)" },
              ]),
        ]}
      />

      <Section title="Production">
        <div className="grid border-t border-border lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="border-b border-border px-4 py-5 sm:px-7 lg:border-b-0 lg:border-r">
            <Suspense fallback={<SitePreviewSkeleton host={new URL(url).host} />}>
              <SitePreviewFrame slug={project.slug} index={listProjects().findIndex((p) => p.id === project.id)} deploymentId={live?.id ?? null} url={url} own={hosts} />
            </Suspense>
          </div>
          <KeyValues
            flush
            items={[
              [
                "Domains",
                <span key="d" className="flex flex-wrap gap-x-3 gap-y-1">
                  {hosts.map((d) => (
                    <a key={d} href={`https://${d}`} className="text-lavender hover:underline">
                      {d}
                    </a>
                  ))}
                </span>,
              ],
              [
                "Deployed",
                live ? (
                  <span key="t">
                    {timeAgo(live.finishedAt ?? live.createdAt)} <span className="text-muted">· by {live.trigger}{live.startedAt && live.finishedAt ? ` · took ${duration((live.finishedAt - live.startedAt) * 1000)}` : ""}</span>
                  </span>
                ) : (
                  "Not yet"
                ),
              ],
              [
                "Commit",
                live ? (
                  <span key="c">
                    <code className="font-mono text-[12.5px]">{live.sha.slice(0, 7)}</code> {live.commitMessage}
                  </span>
                ) : (
                  "Nothing live yet"
                ),
              ],
              [
                "Branch",
                <span key="b">
                  {project.branch} <span className="text-muted">· {project.autoDeploy ? "pushes deploy automatically" : "deploys only when you press Redeploy"}</span>
                </span>,
              ],
              [
                "Runs as",
                isStatic ? (
                  "Caddy serves the files: no process"
                ) : (
                  <span key="r">
                    <code className="font-mono text-[12.5px]">app-{project.slug}</code> <span className="text-muted">· its own Linux user, memory capped at {project.memoryMb} MB</span>
                  </span>
                ),
              ],
            ]}
          />
        </div>
      </Section>

      <DeploymentRows
        slug={project.slug}
        deployments={deployments}
        liveIds={live ? [live.id] : []}
        rollbacks
        head={
          <div className="flex items-end justify-between gap-4 px-4 pb-3.5 pt-[22px] sm:px-7">
            <h2 className="text-[15px] font-semibold">Recent deployments</h2>
            <Link href={`/projects/${project.slug}/deployments`} className="text-[13px] text-lavender hover:underline">
              View all
            </Link>
          </div>
        }
      />
    </>
  );
}

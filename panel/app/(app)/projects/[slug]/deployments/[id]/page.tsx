import { Undo2Icon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cancel, rollback } from "@/app/actions/projects";
import { LogViewer } from "@/components/deploy";
import { SubmitButton } from "@/components/form";
import { Icon } from "@/components/icon";
import { CARD, Notice, PageHeader } from "@/components/page";
import { DeployStatusBadge, duration, timeAgo } from "@/components/status";
import { StatusDot, cx } from "@/components/ui";
import { buildSlots, FINISHED, getDeployment, listDeployments, liveDeployment, queuePosition } from "@/lib/deploy";
import { getProject } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deployment" };

const STEP_LABEL = { fetch: "Fetch", install: "Install", build: "Build", start: "Start", switch: "Switch" } as const;

export default async function DeploymentPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  await requireUser();
  const { slug, id } = await params;
  const d = getDeployment(Number(id));
  if (!d) notFound();
  const project = getProject(d.projectId);
  if (!project || project.slug !== slug) notFound();
  const done = FINISHED.includes(d.status);
  const live = liveDeployment(project.id);
  const total = d.steps.reduce((n, s) => n + (s.ms ?? 0), 0);

  return (
    <>
      <PageHeader
        back={`/projects/${project.slug}/deployments`}
        title={project.slug}
        crumb={`Deployment #${d.id}`}
        meta={
          <>
            <code className="font-mono">{d.sha.slice(0, 7)}</code> · {d.trigger}
            {d.commitAuthor && ` · ${d.commitAuthor}`} · {timeAgo(d.createdAt)}
          </>
        }
        actions={
          <>
            <DeployStatusBadge status={d.status} />
            {!done && (
              <form action={cancel}>
                <input type="hidden" name="deploymentId" value={d.id} />
                <SubmitButton pending="Cancelling…" variant="secondary" className="w-auto">
                  Cancel
                </SubmitButton>
              </form>
            )}
            {d.status === "ready" && live?.id !== d.id && (
              <form action={rollback}>
                <input type="hidden" name="deploymentId" value={d.id} />
                <SubmitButton pending="Starting…" variant="secondary" className="w-auto">
                  <Icon icon={Undo2Icon} size={14} /> Roll back to this
                </SubmitButton>
              </form>
            )}
          </>
        }
      />
      {d.error ? (
        <Notice lead="Failed" tone="err">
          {d.error}. The live version is unchanged.
        </Notice>
      ) : d.status === "queued" ? (
        <Notice lead="Queued" tone="lav">
          {listDeployments(project.id, 20).some((x) => x.id !== d.id && !FINISHED.includes(x.status) && x.status !== "queued")
            ? `Waiting for ${project.slug}'s current deployment to finish.`
            : `Waiting for a free build slot (${buildSlots() === 1 ? "one build at a time" : `${buildSlots()} at a time`}, Settings → Builds)${queuePosition(d.id) ? `, ${queuePosition(d.id)} ahead` : ""}.`}{" "}
          It starts on its own.
        </Notice>
      ) : (
        <Notice lead={done ? (d.status === "ready" ? (live?.id === d.id ? "Live" : "Ready") : "Cancelled") : "Building"} tone={done ? (d.status === "ready" ? "ok" : "lav") : "gold"}>
          {d.commitMessage || `Commit ${d.sha.slice(0, 7)}`}
          {live?.id === d.id && (
            <>
              {" "}
              · serving{" "}
              <Link href={`/projects/${project.slug}`} className="text-accent hover:underline">
                {project.slug}
              </Link>
            </>
          )}
        </Notice>
      )}
      {d.steps.length > 0 && (
        <div className={cx(CARD, "grid grid-cols-2 lg:grid-cols-5")}>
          {d.steps.map((s, i) => {
            const running = !done && s.ms === null && (i === 0 || d.steps[i - 1]!.ms !== null);
            return (
              <div key={i} className="grid gap-1.5 border-b border-border px-3.5 py-3.5 max-lg:odd:border-r lg:border-b-0 lg:border-r lg:last:border-r-0">
                <span className="flex items-center gap-2 text-[12px] text-muted">
                  <StatusDot status={s.ms !== null ? "ok" : running ? "warn" : "idle"} pulse={running} /> {STEP_LABEL[s.name]}
                </span>
                <span className="text-[17px] font-semibold tabular-nums">{s.ms === null ? (running ? "…" : "—") : duration(s.ms)}</span>
                <div className="h-1.5 overflow-hidden rounded bg-track">
                  <div className={cx("h-full rounded", s.name === "build" ? "bg-lavender" : "bg-foreground")} style={{ width: `${total && s.ms ? Math.max(2, (s.ms / total) * 100) : 0}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
      <LogViewer deploymentId={d.id} initialStatus={d.status} />
    </>
  );
}

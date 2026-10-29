import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { rollback } from "@/app/actions/projects";
import { deploymentPath, type Deployment } from "@/lib/deploy";
import { RowList } from "./page";
import { DeployStatusBadge, timeAgo } from "./status";

/** Deployment rows: status, commit, sha, trigger, age; optionally the project and a rollback button. */
export function DeploymentRows({
  deployments,
  slug,
  liveIds = [],
  showProject = false,
  rollbacks = false,
  empty = "No deployments yet.",
}: {
  deployments: (Deployment & { slug?: string })[];
  /** The project, when every row belongs to it (otherwise each row has its own slug). */
  slug?: string;
  liveIds?: number[];
  showProject?: boolean;
  rollbacks?: boolean;
  empty?: string;
}) {
  return (
    <RowList data-testid="deployment-rows">
      {deployments.length === 0 && <p className="px-5 py-10 text-center text-muted">{empty}</p>}
      {deployments.map((d) => {
        const live = liveIds.includes(d.id);
        return (
          <div key={d.id} className="relative flex items-center gap-4 px-4 py-3.5 transition-colors duration-150 hover:bg-subtle sm:px-5">
            <div className="w-[84px] shrink-0">
              <DeployStatusBadge status={d.status} />
            </div>
            <div className="grid min-w-0 flex-1 gap-0.5">
              <Link href={deploymentPath(d.slug ?? slug ?? "", d.id)} className="truncate text-[15px] font-bold after:absolute after:inset-0">
                {d.commitMessage || "Deployment"}
              </Link>
              <p className="truncate text-[13px] text-muted">
                {showProject && d.slug && <span className="font-bold text-foreground">{d.slug} · </span>}
                <code className="font-mono">{d.sha.slice(0, 7)}</code> · {d.trigger}
                {live && <span className="font-bold text-ok"> · live</span>}
              </p>
            </div>
            <p className="hidden shrink-0 text-[13px] text-muted tabular-nums sm:block">{timeAgo(d.createdAt)}</p>
            {rollbacks &&
              (d.status === "ready" && !live ? (
                <form action={rollback} className="relative z-[1]">
                  <input type="hidden" name="deploymentId" value={d.id} />
                  <button type="submit" title="Roll back to this deployment" className="grid size-9 place-items-center rounded-full text-muted transition-colors duration-150 hover:bg-accent/10 hover:text-accent">
                    <RotateCcw className="size-4" aria-hidden />
                    <span className="sr-only">Roll back to this deployment</span>
                  </button>
                </form>
              ) : (
                <span className="size-9 shrink-0" aria-hidden />
              ))}
          </div>
        );
      })}
    </RowList>
  );
}

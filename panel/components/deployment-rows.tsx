import { Undo02Icon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import { rollback } from "@/app/actions/projects";
import { deploymentPath, type Deployment } from "@/lib/deploy";
import { Icon } from "./icon";
import { CARD, Empty, TableHead, TableRow } from "./page";
import { DeployStatusBadge, timeAgo, duration } from "./status";
import { Pill } from "./ui";

/** Deployments as rows: status, commit, (project), trigger, duration, age, and a rollback button. */
export function DeploymentRows({
  deployments,
  slug,
  liveIds = [],
  showProject = false,
  rollbacks = false,
  empty = "No deployments yet.",
  head,
}: {
  deployments: (Deployment & { slug?: string })[];
  /** The project, when every row belongs to it (otherwise each row has its own slug). */
  slug?: string;
  liveIds?: number[];
  showProject?: boolean;
  rollbacks?: boolean;
  empty?: string;
  /** A section title rendered above the column labels. */
  head?: React.ReactNode;
}) {
  const columns = `112px minmax(220px,1fr) ${showProject ? "140px " : ""}90px 80px 64px${rollbacks ? " 36px" : ""}`;
  return (
    <section className={CARD} data-testid="deployment-rows">
      {head}
      <TableHead columns={columns}>
        <span>Status</span>
        <span>Commit</span>
        {showProject && <span>Project</span>}
        <span>Trigger</span>
        <span className="text-right">Duration</span>
        <span className="text-right">Age</span>
        {rollbacks && <span />}
      </TableHead>
      {deployments.length === 0 && <Empty>{empty}</Empty>}
      {deployments.map((d) => {
        const live = liveIds.includes(d.id);
        const building = !["ready", "failed", "cancelled"].includes(d.status);
        return (
          // A stretched link on the commit, not a link around the row: the
          // rollback button can't live inside an <a>.
          <TableRow key={d.id} columns={columns} highlight={building} className="hover:bg-hover" data-testid="deployment-row">
            <span>
              <DeployStatusBadge status={d.status} />
            </span>
            <div className="grid min-w-0 flex-1 gap-px">
              <span className="flex min-w-0 items-center gap-2.5 font-medium">
                <Link href={deploymentPath(d.slug ?? slug ?? "", d.id)} className="truncate after:absolute after:inset-0">
                  {d.commitMessage || "Deployment"}
                </Link>
                {live && <Pill outline>Live</Pill>}
              </span>
              <span className="truncate text-[12.5px] text-muted">
                <code className="font-mono">{d.sha.slice(0, 7)}</code> · {d.trigger}
                {d.error && <span className="text-rose"> · {d.error}</span>}
              </span>
            </div>
            {showProject && <span className="truncate max-md:hidden">{d.slug}</span>}
            <span className="text-muted max-md:hidden">{d.trigger}</span>
            <span className="text-right tabular-nums text-muted max-md:hidden">{d.startedAt && d.finishedAt ? duration((d.finishedAt - d.startedAt) * 1000) : building ? "…" : "—"}</span>
            <span className="text-right tabular-nums text-muted max-md:ml-auto">{timeAgo(d.createdAt)}</span>
            {rollbacks &&
              (d.status === "ready" && !live ? (
                <form action={rollback} className="relative z-[1] max-md:hidden">
                  <input type="hidden" name="deploymentId" value={d.id} />
                  <button type="submit" title="Roll back to this deployment" className="grid size-8 place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground">
                    <Icon icon={Undo02Icon} size={16} />
                    <span className="sr-only">Roll back to this deployment</span>
                  </button>
                </form>
              ) : (
                <span className="max-md:hidden" />
              ))}
          </TableRow>
        );
      })}
    </section>
  );
}

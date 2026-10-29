import { RestoreButton } from "./backups";
import { Empty, TableHead } from "./page";
import { StatusText, duration, timeAgo } from "./status";
import type { Backup } from "@/lib/backup/runner";

export function formatBytes(n: number | null): string {
  if (n === null) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

const STATUS = { running: ["warn", "Backing up…"], ok: ["ok", "Backed up"], failed: ["err", "Failed"] } as const;

function contents(b: Backup): string {
  const dbs = b.contents?.sqlite ?? [];
  return [dbs.length ? `${dbs.length} SQLite database${dbs.length === 1 ? "" : "s"} checked` : null, b.contents?.postgres ? "Postgres dump" : null, b.contents?.mysql ? "MySQL dump" : null, b.kind === "panel" ? "Panel database and key" : null, b.trigger === "schedule" ? "scheduled" : "manual"]
    .filter(Boolean)
    .join(" · ");
}

/** Backups as rows. The column labels sit outside the list, so the list's first child is the newest backup. */
export function BackupList({ backups, showApp = false, restorable = false, empty }: { backups: Backup[]; showApp?: boolean; restorable?: boolean; empty: string }) {
  const columns = `120px ${showApp ? "130px " : ""}minmax(180px,1fr) 90px 90px ${restorable ? "90px" : ""}`;
  return (
    <>
      <TableHead columns={columns}>
        <span>Status</span>
        {showApp && <span>App</span>}
        <span>Contents</span>
        <span className="text-right">Size</span>
        <span className="text-right">Age</span>
        {restorable && <span />}
      </TableHead>
      <div data-testid="backup-list">
        {backups.length === 0 && <Empty>{empty}</Empty>}
        {backups.map((b) => (
          <div
            key={b.id}
            data-status={b.status}
            style={{ gridTemplateColumns: columns }}
            className="flex min-h-[56px] flex-wrap items-center gap-x-3.5 gap-y-1 border-b border-border px-4 py-2.5 text-[14.5px] last:border-b-0 md:grid md:gap-x-5 md:px-7"
          >
            <span>
              <StatusText status={STATUS[b.status][0]} label={STATUS[b.status][1]} pulse={b.status === "running"} />
            </span>
            {showApp && <span className="truncate font-medium">{b.kind === "panel" ? "panel" : b.slug}</span>}
            <span className={b.status === "failed" ? "min-w-0 flex-1 truncate text-rose" : "min-w-0 flex-1 truncate text-muted"}>{b.status === "failed" ? b.error : contents(b)}</span>
            <span className="text-right tabular-nums max-md:hidden">{formatBytes(b.bytes)}</span>
            <span className="text-right tabular-nums text-muted max-md:ml-auto" title={new Date(b.startedAt).toISOString()}>
              {timeAgo(Math.floor(b.startedAt / 1000))}
              {b.finishedAt && <span className="text-dim max-lg:hidden"> · {duration(b.finishedAt - b.startedAt)}</span>}
            </span>
            {restorable && <span className="justify-self-end">{b.status === "ok" && b.kind === "app" && <RestoreButton id={b.id} slug={b.slug} />}</span>}
          </div>
        ))}
      </div>
    </>
  );
}

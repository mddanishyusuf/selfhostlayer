import { RestoreButton } from "./backups";
import { duration, timeAgo } from "./status";
import { Card, StatusDot } from "./ui";
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

const DOT = { running: "warn", ok: "ok", failed: "err" } as const;
const LABEL = { running: "Backing up…", ok: "Backed up", failed: "Failed" } as const;

export function BackupList({ backups, showApp = false, restorable = false, empty }: { backups: Backup[]; showApp?: boolean; restorable?: boolean; empty: string }) {
  return (
    <Card className="divide-y divide-border overflow-hidden" data-testid="backup-list">
      {backups.length === 0 && <p className="px-5 py-6 text-muted">{empty}</p>}
      {backups.map((b) => {
        const dbs = b.contents?.sqlite ?? [];
        return (
          <div key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3" data-status={b.status}>
            <span className="inline-flex w-32 items-center gap-2 text-[13px] font-medium">
              <StatusDot status={DOT[b.status]} /> {LABEL[b.status]}
            </span>
            {showApp && <span className="w-28 truncate font-mono text-[13px]">{b.kind === "panel" ? "panel" : b.slug}</span>}
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted">
              {b.status === "failed"
                ? b.error
                : [formatBytes(b.bytes), dbs.length ? `${dbs.length} SQLite database${dbs.length === 1 ? "" : "s"} checked` : null, b.contents?.postgres ? "Postgres dump" : null, b.trigger === "schedule" ? "scheduled" : "manual"].filter(Boolean).join(" · ")}
            </span>
            <span className="text-[12px] tabular-nums text-muted" title={new Date(b.startedAt).toISOString()}>
              {timeAgo(Math.floor(b.startedAt / 1000))}
              {b.finishedAt && ` · ${duration(b.finishedAt - b.startedAt)}`}
            </span>
            {restorable && b.status === "ok" && b.kind === "app" && <RestoreButton id={b.id} slug={b.slug} />}
          </div>
        );
      })}
    </Card>
  );
}

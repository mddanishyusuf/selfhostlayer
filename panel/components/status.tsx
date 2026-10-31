import { StatusDot, cx } from "./ui";

const STATUS: Record<string, { label: string; dot: "ok" | "warn" | "err" | "idle" }> = {
  queued: { label: "Queued", dot: "idle" },
  fetching: { label: "Fetching", dot: "warn" },
  installing: { label: "Installing", dot: "warn" },
  building: { label: "Building", dot: "warn" },
  starting: { label: "Starting", dot: "warn" },
  switching: { label: "Switching", dot: "warn" },
  ready: { label: "Ready", dot: "ok" },
  failed: { label: "Failed", dot: "err" },
  cancelled: { label: "Cancelled", dot: "idle" },
};

export function DeployStatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, dot: "idle" as const };
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-[13.5px]">
      <StatusDot status={s.dot} pulse={s.dot === "warn"} /> {s.label}
    </span>
  );
}

/** "Live", "Pending", "Failed"… with a matching dot. */
export function StatusText({ status, label, pulse }: { status: "ok" | "warn" | "err" | "idle"; label: string; pulse?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-[13.5px]">
      <StatusDot status={status} pulse={pulse} /> {label}
    </span>
  );
}

export const projectStatusLabel = { ok: "Ready", warn: "Building", err: "Failed", idle: "Not deployed" } as const;

export function timeAgo(seconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** "in 42m" for a time ahead (ms since the epoch). */
export function timeIn(ms: number): string {
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  if (s < 60) return "in under a minute";
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

export const duration = (ms: number | null) => (ms === null ? "…" : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

/** A state as a soft tag: a colored dot, then the word in the darker shade. */
export function StatusChip({ status, label, pulse }: { status: "ok" | "warn" | "err" | "idle"; label: string; pulse?: boolean }) {
  const look = { ok: "bg-ok-soft text-teal", warn: "bg-warn-soft text-gold", err: "bg-err-soft text-rose", idle: "bg-well text-muted" }[status];
  return (
    <span className={cx("inline-flex h-[26px] items-center gap-[7px] whitespace-nowrap rounded-lg px-2.5 text-[13px] font-medium", look)}>
      <StatusDot status={status} pulse={pulse} /> {label}
    </span>
  );
}

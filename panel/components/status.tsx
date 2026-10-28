import { StatusDot } from "./ui";

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
    <span className="inline-flex items-center gap-2 text-[13px] font-medium">
      <StatusDot status={s.dot} /> {s.label}
    </span>
  );
}

export function timeAgo(seconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const duration = (ms: number | null) => (ms === null ? "…" : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

import { CircleAlert, CircleCheck } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { agent, type SystemInfo } from "@/lib/agent";
import { listIncidents } from "@/lib/alerts/engine";
import { timeAgo } from "../status";
import { Skeleton, StatusDot, cx } from "../ui";

function Meter({ label, value, detail }: { label: string; value: number; detail: string }) {
  const pct = Math.min(100, Math.max(0, value * 100));
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="font-bold">{label}</span>
        <span className="text-muted tabular-nums">{detail}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-hover" role="meter" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className={cx("h-full rounded-full", pct >= 90 ? "bg-err" : pct >= 80 ? "bg-warn" : "bg-accent")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

async function ServerBox() {
  let info: SystemInfo;
  try {
    info = await agent<SystemInfo>("system.info");
  } catch {
    return <p className="px-4 pb-4 text-[13px] text-err">Can&apos;t reach the server agent.</p>;
  }
  const gb = (mb: number) => (mb / 1024).toFixed(1);
  const memUsed = info.memoryMb.total - info.memoryMb.available;
  const diskUsed = info.diskGb.total - info.diskGb.free;
  const load = info.loadavg[0] ?? 0;
  return (
    <div className="grid gap-4 px-4 pb-4">
      <p className="flex items-center gap-2 text-[13px] text-muted">
        <StatusDot status={info.caddy === "active" ? "ok" : "err"} /> <span className="truncate">{info.hostname} · {info.os.name}</span>
      </p>
      <Meter label="CPU" value={load / info.cpus} detail={`${Math.round((load / info.cpus) * 100)}% of ${info.cpus} cores`} />
      <Meter label="Memory" value={memUsed / info.memoryMb.total} detail={`${gb(memUsed)} / ${gb(info.memoryMb.total)} GB`} />
      <Meter label="Disk" value={diskUsed / info.diskGb.total} detail={`${diskUsed.toFixed(1)} / ${info.diskGb.total} GB`} />
    </div>
  );
}

/** Right column on wide screens, like X's "What's happening": the server and open incidents. */
export function RightRail() {
  const open = listIncidents().filter((i) => !i.resolvedAt);
  return (
    <aside className="sticky top-0 hidden h-dvh w-[350px] shrink-0 overflow-y-auto px-6 py-3 xl:block">
      <div className="grid gap-4">
        <div className="overflow-hidden rounded-2xl border border-border">
          <h2 className="px-4 pb-3 pt-3 text-[20px] font-extrabold tracking-tight">Server</h2>
          <Suspense
            fallback={
              <div className="grid gap-4 px-4 pb-4">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
              </div>
            }
          >
            <ServerBox />
          </Suspense>
        </div>

        <div className="overflow-hidden rounded-2xl border border-border">
          <h2 className="px-4 pb-1 pt-3 text-[20px] font-extrabold tracking-tight">Incidents</h2>
          {open.length === 0 ? (
            <p className="flex items-center gap-2 px-4 pb-4 pt-2 text-[14px] text-muted">
              <CircleCheck className="size-4 text-ok" aria-hidden /> Everything looks fine.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {open.slice(0, 4).map((i) => (
                <Link key={i.id} href="/settings/alerts" className="grid gap-0.5 px-4 py-3 transition-colors duration-150 hover:bg-subtle">
                  <p className="text-[12px] text-muted">{timeAgo(i.openedAt)}</p>
                  <p className="flex items-start gap-2 text-[14px] font-bold">
                    <CircleAlert className="mt-0.5 size-4 shrink-0 text-err" aria-hidden /> {i.title}
                  </p>
                </Link>
              ))}
              {open.length > 4 && (
                <Link href="/settings/alerts" className="block px-4 py-3 text-[14px] text-accent hover:bg-subtle">
                  Show all {open.length}
                </Link>
              )}
            </div>
          )}
        </div>

        <p className="px-4 text-[12px] leading-relaxed text-muted">
          Self Host Layer · every app sandboxed, no Docker. Apps keep running if the panel stops.
        </p>
      </div>
    </aside>
  );
}

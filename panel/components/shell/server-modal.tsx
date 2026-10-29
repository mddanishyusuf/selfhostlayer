"use client";

import { ServerStack01Icon } from "@hugeicons/core-free-icons";
import { useCallback, useEffect, useState } from "react";
import { serverStats, type ServerStats } from "@/app/actions/server";
import { Icon } from "../icon";
import { Modal } from "../modal";
import { Skeleton, StatusDot, cx } from "../ui";

/** Opens the server modal from anywhere (the sidebar, the Projects header). */
export const openServerModal = () => window.dispatchEvent(new Event("layer:server"));

function Meter({ value }: { value: number }) {
  const pct = Math.min(100, Math.max(1.5, value * 100));
  const color = value >= 0.9 ? "bg-rose" : value >= 0.75 ? "bg-gold" : "bg-teal";
  return (
    <div className="mt-1.5 h-1.5 overflow-hidden rounded bg-track" role="meter" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx("h-full rounded", color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Stat({ label, value, small, meter, detail, odd }: { label: string; value: string; small?: string; meter?: number; detail: string; odd?: boolean }) {
  return (
    <div className={cx("grid gap-1.5 border-b border-border px-6 py-[18px]", odd && "border-r")}>
      <span className="text-[13px] text-dim">{label}</span>
      <span className="text-2xl font-semibold tracking-tight tabular-nums">
        {value}
        {small && <small className="ml-1 text-[13px] font-normal text-muted">{small}</small>}
      </span>
      {meter !== undefined ? <Meter value={meter} /> : <span className="h-3" />}
      <span className="text-[12.5px] text-muted">{detail}</span>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function ServerModal({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<ServerStats | null>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      setStats(null);
      serverStats().then(setStats, () => setStats({ info: null, apps: [] }));
    };
    window.addEventListener("layer:server", onOpen);
    return () => window.removeEventListener("layer:server", onOpen);
  }, []);

  const info = stats?.info;
  const gb = (mb: number) => (mb / 1024).toFixed(1);
  const maxApp = Math.max(1, ...(stats?.apps.map((a) => a.memoryMb ?? 0) ?? [1]));
  return (
    <Modal
      open={open}
      onClose={close}
      label="Server"
      icon={<StatusDot status={info ? (info.caddy === "active" ? "ok" : "err") : "idle"} />}
      title={info?.hostname ?? name}
      description={info ? `${info.cpus} vCPU · ${gb(info.memoryMb.total)} GB · ${info.os.name}` : "Loading…"}
    >
      {!stats ? (
        <div className="grid gap-4 p-6">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : !info ? (
        <p className="px-6 py-8 text-[14px] text-rose">Can&apos;t reach the server agent. On the server: systemctl status layer-agent</p>
      ) : (
        <>
          <div className="grid grid-cols-2">
            <Stat odd label="CPU" value={`${Math.round(((info.loadavg[0] ?? 0) / info.cpus) * 100)}%`} small={`of ${info.cpus} cores`} meter={(info.loadavg[0] ?? 0) / info.cpus} detail={`Load ${info.loadavg.map((l) => l.toFixed(2)).join(" · ")}`} />
            <Stat
              label="Memory"
              value={`${gb(info.memoryMb.total - info.memoryMb.available)} GB`}
              small={`of ${gb(info.memoryMb.total)}`}
              meter={(info.memoryMb.total - info.memoryMb.available) / info.memoryMb.total}
              detail={`${gb(info.memoryMb.available)} GB free · swap ${gb(info.swapMb.total)} GB`}
            />
            <Stat odd label="Disk" value={`${(info.diskGb.total - info.diskGb.free).toFixed(1)} GB`} small={`of ${info.diskGb.total}`} meter={(info.diskGb.total - info.diskGb.free) / info.diskGb.total} detail={`${info.diskGb.free} GB free`} />
            <Stat label="Uptime" value={formatUptime(info.uptimeSec)} detail={`Caddy ${info.caddy} · agent ${info.agentVersion}`} />
          </div>
          {stats.apps.length > 0 && (
            <div className="pb-3">
              <p className="px-6 pb-2 pt-4 text-[13px] text-dim">Memory by app</p>
              {stats.apps.map((a) => (
                <div key={a.slug} className="grid grid-cols-[minmax(0,1fr)_minmax(120px,1fr)_70px] items-center gap-4 px-6 py-2 text-[14px]">
                  <span className="truncate">{a.slug}</span>
                  <div className="h-1.5 overflow-hidden rounded bg-track">
                    <div className="h-full rounded bg-lavender" style={{ width: `${Math.max(1.5, ((a.memoryMb ?? 0) / maxApp) * 100)}%` }} />
                  </div>
                  <span className="text-right tabular-nums text-muted">{a.memoryMb === null ? "—" : `${a.memoryMb} MB`}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-3.5 border-t border-border px-6 pb-4 pt-3.5 text-[12.5px] text-dim">
            <span>Node {info.nodeVersions.join(", ") || "none"}</span>
            <span>{info.kernel}</span>
            <span className="inline-flex items-center gap-1.5">
              <Icon icon={ServerStack01Icon} size={13} /> {info.arch}
            </span>
          </div>
        </>
      )}
    </Modal>
  );
}

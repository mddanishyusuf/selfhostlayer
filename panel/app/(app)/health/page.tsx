import Link from "next/link";
import { KeyValues, Notice, PageHeader, Section, Segmented, Stats } from "@/components/page";
import { UsageChart } from "@/components/usage-chart";
import { Mark, StatusDot, cx } from "@/components/ui";
import { agent, type SystemInfo } from "@/lib/agent";
import { boxConfig } from "@/lib/box";
import { FINISHED, listDeployments, liveDeployment } from "@/lib/deploy";
import { history, latestUsage, type Range } from "@/lib/metrics";
import { listProjects } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Health" };

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** How full something is: gold from 75%, rose from 90%. */
function Meter({ value }: { value: number }) {
  const color = value >= 0.9 ? "bg-err-dot" : value >= 0.75 ? "bg-warn-dot" : "bg-blue";
  return (
    <span className="mt-1.5 block h-1.5 overflow-hidden rounded bg-track" role="meter" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <span className={cx("block h-full rounded", color)} style={{ width: `${Math.min(100, Math.max(1.5, value * 100))}%` }} />
    </span>
  );
}

export default async function HealthPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  await requireUser();
  const range: Range = (await searchParams).range === "7d" ? "7d" : "24h";
  const info = await agent<SystemInfo>("system.info").catch(() => null);
  let version = "dev";
  try {
    ({ version } = boxConfig());
  } catch {
    // dev: no box config
  }
  const now = Date.now();
  const usage = history("box", range, now);
  const from = now - (range === "24h" ? 86_400_000 : 7 * 86_400_000);
  const gapMs = range === "24h" ? 15 * 60_000 : 3 * 3_600_000;
  const latest = latestUsage(now);
  const apps = listProjects()
    .filter((p) => p.runtime.kind !== "static")
    .map((p) => {
      const last = listDeployments(p.id, 1)[0];
      const building = last && !FINISHED.includes(last.status);
      return { project: p, usage: latest.get(p.slug), live: Boolean(liveDeployment(p.id)), building };
    })
    .sort((a, b) => (b.usage?.memoryMb ?? -1) - (a.usage?.memoryMb ?? -1));
  const gb = (mb: number) => (mb / 1024).toFixed(1);

  return (
    <>
      <PageHeader title="Health" meta={info ? `${info.hostname} · ${info.os.name}` : undefined} />
      {!info ? (
        <Notice lead="Unreachable" tone="err">
          The panel can&apos;t reach the server agent. On the server: <code className="font-mono text-[13px]">systemctl status layer-agent</code>
        </Notice>
      ) : (
        <>
          <Notice lead={info.caddy === "active" ? "Running" : "Caddy is down"} tone={info.caddy === "active" ? "ok" : "err"}>
            Up {uptime(info.uptimeSec)} · {info.cpus} vCPU · {gb(info.memoryMb.total)} GB · {info.os.name}
          </Notice>
          <Stats
            items={[
              {
                label: "CPU",
                value: `${Math.round(((info.loadavg[0] ?? 0) / info.cpus) * 100)}%`,
                small: `of ${info.cpus} cores`,
                detail: <Meter value={(info.loadavg[0] ?? 0) / info.cpus} />,
              },
              {
                label: "Memory",
                value: gb(info.memoryMb.total - info.memoryMb.available),
                small: `of ${gb(info.memoryMb.total)} GB`,
                detail: <Meter value={(info.memoryMb.total - info.memoryMb.available) / info.memoryMb.total} />,
              },
              {
                label: "Disk",
                value: (info.diskGb.total - info.diskGb.free).toFixed(1),
                small: `of ${info.diskGb.total} GB`,
                detail: <Meter value={(info.diskGb.total - info.diskGb.free) / info.diskGb.total} />,
              },
              {
                label: "Swap",
                value: gb(info.swapMb.total - info.swapMb.free),
                small: `of ${gb(info.swapMb.total)} GB`,
                detail: <Meter value={info.swapMb.total ? (info.swapMb.total - info.swapMb.free) / info.swapMb.total : 0} />,
              },
            ]}
          />
        </>
      )}

      <Section
        title="CPU and memory"
        description="The whole server, sampled every minute"
        aside={
          <Segmented
            items={[
              { href: "/health", label: "24 hours", active: range === "24h" },
              { href: "/health?range=7d", label: "7 days", active: range === "7d" },
            ]}
          />
        }
      >
        <div className="grid gap-x-10 gap-y-6 border-t border-border px-3.5 py-5 lg:grid-cols-2">
          <UsageChart title="CPU" unit="%" points={usage.map((p) => ({ at: p.at, value: p.cpu }))} from={from} to={now} gapMs={gapMs} />
          <UsageChart title="Memory" unit="MB" points={usage.map((p) => ({ at: p.at, value: p.memoryMb }))} from={from} to={now} gapMs={gapMs} />
        </div>
      </Section>

      {apps.length > 0 && (
        <Section title="Apps" description="Each app runs as its own user, with its own memory limit.">
          <div className="hidden h-9 grid-cols-[30px_minmax(0,1fr)_minmax(0,1.3fr)_64px_110px] items-center gap-x-5 border-y border-border px-3.5 text-[12px] text-muted md:grid">
            <span />
            <span>App</span>
            <span>Memory</span>
            <span className="text-right">CPU</span>
            <span>Status</span>
          </div>
          {apps.map(({ project: p, usage: u, live, building }) => {
            const used = u?.memoryMb ?? null;
            return (
              <Link
                key={p.slug}
                href={`/projects/${p.slug}`}
                className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-x-5 gap-y-1 border-b border-border px-3.5 py-3 transition-colors duration-150 last:border-b-0 hover:bg-hover md:grid-cols-[30px_minmax(0,1fr)_minmax(0,1.3fr)_64px_110px]"
              >
                <Mark framework={p.framework} size="sm" />
                <span className="truncate font-medium">{p.slug}</span>
                <span className="col-span-full flex items-center gap-3 md:col-span-1">
                  <span className="h-1.5 flex-1 overflow-hidden rounded bg-track">
                    <span className={cx("block h-full rounded", used !== null && used / p.memoryMb >= 0.75 ? "bg-warn-dot" : "bg-blue")} style={{ width: `${used === null ? 0 : Math.max(1.5, Math.min(100, (used / p.memoryMb) * 100))}%` }} />
                  </span>
                  <span className="w-[112px] text-right text-[12px] tabular-nums text-muted">{used === null ? "—" : `${used} of ${p.memoryMb} MB`}</span>
                </span>
                <span className="hidden text-right text-[13px] tabular-nums md:block">{u?.cpu == null ? "—" : `${u.cpu}%`}</span>
                <span className="col-start-3 row-start-1 flex items-center gap-2 text-[13.5px] md:col-start-auto md:row-auto">
                  <StatusDot status={building ? "warn" : live ? "ok" : "idle"} pulse={building} />
                  {building ? "Building" : live ? "Running" : "Not running"}
                </span>
              </Link>
            );
          })}
        </Section>
      )}

      {info && (
        <Section title="Software">
          <KeyValues
            items={[
              ["Caddy", <span key="c">{info.caddy === "active" ? "Running" : info.caddy}</span>],
              ["Agent", <span key="a">{info.agentVersion}</span>],
              ["Panel", <span key="p">{version}</span>],
              ["Node", <span key="n">{info.nodeVersions.join(", ") || "None installed"}</span>],
              ["System", <span key="s">{info.os.name} · {info.kernel} · {info.arch}</span>],
            ]}
          />
        </Section>
      )}
    </>
  );
}

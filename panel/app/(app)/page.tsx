import { ArrowUpRight, GitBranch, ServerCrash } from "lucide-react";
import { Suspense } from "react";
import { Button, Card, Skeleton, StatusDot, cx } from "@/components/ui";
import { agent, type AppSummary, type SystemInfo } from "@/lib/agent";

export const dynamic = "force-dynamic";
export const metadata = { title: "Overview" };

export default function OverviewPage() {
  return (
    <div className="grid gap-10">
      <Suspense fallback={<ServerSkeleton />}>
        <Server />
      </Suspense>
      <Suspense fallback={<AppsSkeleton />}>
        <Apps />
      </Suspense>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function Meter({ value }: { value: number }) {
  const pct = Math.min(100, Math.max(0, value * 100));
  const color = pct >= 90 ? "bg-err" : pct >= 80 ? "bg-warn" : "bg-foreground";
  return (
    <div className="h-1 overflow-hidden rounded-full bg-hover" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx("h-full rounded-full transition-[width] duration-500 ease-out", color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Stat({ label, value, detail, meter }: { label: string; value: string; detail: string; meter?: number }) {
  return (
    <Card className="grid gap-3 p-4 sm:p-5">
      <p className="text-[13px] text-muted">{label}</p>
      <p className="text-xl font-semibold tracking-tight tabular-nums sm:text-2xl">{value}</p>
      {meter !== undefined ? <Meter value={meter} /> : <div className="h-1" aria-hidden />}
      <p className="text-[12px] leading-snug text-muted tabular-nums">{detail}</p>
    </Card>
  );
}

function SectionTitle({ title, aside }: { title: string; aside?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {aside}
    </div>
  );
}

function AgentDown() {
  return (
    <Card className="flex items-start gap-3 p-5">
      <ServerCrash className="mt-0.5 size-4 text-err" aria-hidden />
      <div className="grid gap-1">
        <p className="font-medium">Can't reach the server agent</p>
        <p className="text-muted">
          On the server, check <code className="font-mono text-[13px]">systemctl status layer-agent</code>.
        </p>
      </div>
    </Card>
  );
}

async function Server() {
  let info: SystemInfo;
  try {
    info = await agent<SystemInfo>("system.info");
  } catch {
    return (
      <section>
        <SectionTitle title="Server" />
        <AgentDown />
      </section>
    );
  }
  const memUsed = info.memoryMb.total - info.memoryMb.available;
  const diskUsed = info.diskGb.total - info.diskGb.free;
  const load = info.loadavg[0] ?? 0;
  const gb = (mb: number) => (mb / 1024).toFixed(1);

  return (
    <section>
      <SectionTitle
        title="Server"
        aside={
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <StatusDot status={info.caddy === "active" ? "ok" : "err"} />
            <span className="font-medium text-foreground">{info.hostname}</span>
            <span className="hidden sm:inline">· {info.os.name} · {info.arch}</span>
          </p>
        }
      />
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label="CPU" value={`${Math.round((load / info.cpus) * 100)}%`} meter={load / info.cpus} detail={`Load ${info.loadavg.join(" · ")} on ${info.cpus} cores`} />
        <Stat label="Memory" value={`${gb(memUsed)} GB`} meter={memUsed / info.memoryMb.total} detail={`of ${gb(info.memoryMb.total)} GB · swap ${gb(info.swapMb.total)} GB`} />
        <Stat label="Disk" value={`${diskUsed.toFixed(1)} GB`} meter={diskUsed / info.diskGb.total} detail={`of ${info.diskGb.total} GB · ${info.diskGb.free} GB free`} />
        <Stat label="Uptime" value={formatUptime(info.uptimeSec)} detail={`Node ${info.nodeVersions.join(", ") || "none"}`} />
      </div>
    </section>
  );
}

async function Apps() {
  let apps: AppSummary[];
  try {
    ({ apps } = await agent<{ apps: AppSummary[] }>("app.list"));
  } catch {
    return null;
  }
  const connect = (
    <Button variant="secondary" disabled title="Arrives in Week 2" className="h-8 px-3 text-[13px]">
      <GitBranch className="size-3.5" aria-hidden /> Connect GitHub
    </Button>
  );

  if (apps.length === 0) {
    return (
      <section>
        <SectionTitle title="Projects" />
        <Card className="grid place-items-center gap-4 border-dashed px-6 py-16 text-center">
          <div className="grid gap-1">
            <p className="font-medium">No projects yet</p>
            <p className="text-muted">Connect GitHub to deploy your first app. Each one runs as its own sandboxed user.</p>
          </div>
          {connect}
        </Card>
      </section>
    );
  }

  return (
    <section>
      <SectionTitle title="Projects" aside={connect} />
      <Card className="divide-y divide-border overflow-hidden">
        {apps.map((app) => (
          <div key={app.slug} className="flex items-center gap-4 px-5 py-4 transition-colors duration-150 hover:bg-subtle">
            <StatusDot status={app.live ? "ok" : "idle"} />
            <div className="grid min-w-0 flex-1 gap-0.5">
              <p className="font-medium">{app.slug}</p>
              <p className="truncate text-[13px] text-muted">{app.domains.length ? app.domains.join(", ") : "No domain yet"}</p>
            </div>
            <p className="hidden text-[13px] text-muted tabular-nums sm:block">
              {app.live === "static" ? (
                <span className="text-foreground">static</span>
              ) : app.live ? (
                <>
                  <span className="text-foreground">{app.live}</span> :{app.ports[app.live]}
                </>
              ) : (
                "Not deployed"
              )}
            </p>
            {app.domains[0] && (
              <a href={`https://${app.domains[0]}`} target="_blank" rel="noreferrer" title={`Open ${app.domains[0]}`} className="grid size-8 place-items-center rounded-md text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground">
                <ArrowUpRight className="size-4" aria-hidden />
                <span className="sr-only">Open {app.domains[0]}</span>
              </a>
            )}
          </div>
        ))}
      </Card>
    </section>
  );
}

function ServerSkeleton() {
  return (
    <section>
      <SectionTitle title="Server" />
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="grid gap-3 p-5">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-1 w-full" />
            <Skeleton className="h-3 w-32" />
          </Card>
        ))}
      </div>
    </section>
  );
}

function AppsSkeleton() {
  return (
    <section>
      <SectionTitle title="Projects" />
      <Card className="divide-y divide-border">
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-4">
            <Skeleton className="size-2 rounded-full" />
            <div className="grid flex-1 gap-1.5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-48" />
            </div>
          </div>
        ))}
      </Card>
    </section>
  );
}

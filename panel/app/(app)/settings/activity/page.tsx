import { Empty, PageHeader, TableHead, TableRow } from "@/components/page";
import { StatusText, timeAgo } from "@/components/status";
import { agent } from "@/lib/agent";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Activity" };

interface Entry {
  id: string;
  ts: string;
  action: string;
  params: Record<string, unknown> | null;
  ok: boolean | null;
  code: string | null;
  ms: number | null;
}

// What each privileged action did, in words. Anything new shows its raw name.
const LABELS: Record<string, string> = {
  "app.create": "Set up the app",
  "app.delete": "Deleted the app",
  "env.write": "Wrote env vars",
  "unit.write": "Wrote its service unit",
  "unit.start": "Started a version",
  "unit.stop": "Stopped a version",
  "release.point": "Pointed a version at a build",
  "release.prune": "Pruned old builds",
  "source.fetch": "Fetched the source from GitHub",
  "build.run": "Built",
  "build.cancel": "Cancelled a build",
  "cache.clean": "Cleaned build caches",
  "cron.write": "Saved a cron job",
  "cron.delete": "Deleted a cron job",
  "cron.run": "Ran a cron job",
  "backup.snapshot": "Took a backup snapshot",
  "backup.restore": "Restored a backup",
  "backup.discard": "Cleared a backup snapshot",
  "data.import": "Imported data",
  "service.install": "Installed a service",
  "redis.add": "Added Redis",
  "redis.remove": "Removed Redis",
  "postgres.add": "Added Postgres",
  "postgres.remove": "Removed Postgres",
  "mysql.add": "Added MySQL",
  "mysql.remove": "Removed MySQL",
  "proxy.set": "Routed its domains",
  "static.publish": "Published static files",
  "panel.site": "Wrote the panel's site",
  "panel.address": "Changed the panel's address",
  "panel.access": "Changed who can open the panel",
  "apps.domain": "Moved the app URLs",
  "system.repair": "Repaired files",
  "update.start": "Started an update",
  "node.install": "Installed Node",
  "tool.install": "Installed a build tool",
};

/** The app, version or name an action was about. */
function target(params: Record<string, unknown> | null): string {
  if (!params) return "";
  const parts = [params.slug, params.name, params.version, params.domain, Array.isArray(params.hosts) ? params.hosts[0] : undefined, params.color].filter((v) => typeof v === "string" && v);
  return parts.slice(0, 2).join(" · ");
}

export default async function ActivityPage() {
  await requireUser();
  const result = await agent<{ entries: Entry[] }>("audit.tail", { limit: 300 }).catch(() => null);
  const entries = result?.entries ?? [];
  const columns = "minmax(220px,1.4fr) minmax(140px,1fr) 120px 70px 80px";
  return (
    <>
      <PageHeader title="Activity" meta="Every change the agent made, from its root-only log" />
      <section className="border-b border-border" data-testid="activity">
        <TableHead columns={columns}>
          <span>What</span>
          <span>About</span>
          <span>Result</span>
          <span className="text-right">Took</span>
          <span className="text-right">When</span>
        </TableHead>
        {!result && <Empty>Couldn&apos;t read the agent&apos;s log.</Empty>}
        {result && entries.length === 0 && <Empty>Nothing yet. Deploys, domain changes, backups and every other change show up here.</Empty>}
        {entries.map((e) => (
          <TableRow key={e.id} columns={columns} data-action={e.action}>
            <span className="font-medium">{LABELS[e.action] ?? e.action}</span>
            <span className="truncate font-mono text-[12.5px] text-muted">{target(e.params)}</span>
            <span>{e.ok === null ? <StatusText status="warn" label="Running" pulse /> : e.ok ? <StatusText status="ok" label="Done" /> : <span title={e.code ?? undefined}><StatusText status="err" label="Failed" /></span>}</span>
            <span className="text-right tabular-nums text-muted">{e.ms === null ? "…" : e.ms < 1000 ? `${e.ms} ms` : `${(e.ms / 1000).toFixed(1)} s`}</span>
            <span className="text-right tabular-nums text-muted" title={e.ts}>
              {timeAgo(Math.floor(Date.parse(e.ts) / 1000))}
            </span>
          </TableRow>
        ))}
      </section>
    </>
  );
}

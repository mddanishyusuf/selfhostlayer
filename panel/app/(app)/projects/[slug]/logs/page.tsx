import Link from "next/link";
import { notFound } from "next/navigation";
import { AppLogs } from "@/components/deploy";
import { Empty, PageHeader, Tabs, TableHead, TableRow } from "@/components/page";
import { StatusDot } from "@/components/ui";
import { agent } from "@/lib/agent";
import { deploymentPath, liveDeployment, listDeployments } from "@/lib/deploy";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Logs" };

interface Request {
  at: number;
  status: number;
  method: string;
  host: string;
  uri: string;
  ip: string;
  ms: number;
  bytes: number;
}

const size = (b: number) => (b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 ** 2).toFixed(1)} MB`);
const statusTone = (s: number) => (s >= 500 ? "err" : s >= 400 ? "warn" : s >= 300 || s === 0 ? "idle" : "ok") as "ok" | "warn" | "err" | "idle";

export default async function LogsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ tab?: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project) notFound();
  const isStatic = project.runtime.kind === "static";
  // A static site has no process: requests are all there is.
  const tab = isStatic || (await searchParams).tab === "requests" ? "requests" : "output";
  const latest = listDeployments(project.id, 1)[0];
  const base = `/projects/${project.slug}/logs`;
  const requests = tab === "requests" ? await agent<{ requests: Request[] }>("requests.tail", { slug: project.slug, limit: 200 }).then((r) => r.requests).catch(() => null) : null;
  const errors = requests?.filter((r) => r.status >= 500).length ?? 0;
  const columns = "78px 70px minmax(220px,1fr) 70px 80px 130px";

  return (
    <>
      <PageHeader
        title={project.slug}
        crumb="Logs"
        meta={tab === "output" ? <code className="font-mono">journalctl -u &apos;app-{project.slug}@*&apos;</code> : <code className="font-mono">/var/log/caddy/{project.slug}.log</code>}
        actions={
          tab === "requests" ? (
            <Link href={`${base}?tab=requests`} className="text-[13px] text-accent hover:underline">
              Refresh
            </Link>
          ) : (
            latest && (
              <a href={deploymentPath(project.slug, latest.id)} className="text-[13px] text-accent hover:underline">
                Latest build log
              </a>
            )
          )
        }
      />
      {!isStatic && (
        <Tabs
          items={[
            { href: base, label: "Output", active: tab === "output" },
            { href: `${base}?tab=requests`, label: "Requests", active: tab === "requests" },
          ]}
        />
      )}
      {tab === "output" &&
        (!liveDeployment(project.id) ? <Empty>Nothing is running yet. Logs appear here once the first deploy is live.</Empty> : <AppLogs slug={project.slug} />)}
      {tab === "requests" && (
        <section className="border-b border-border" data-testid="requests">
          {requests && requests.length > 0 && (
            <p className="px-4 py-3 text-[13px] text-muted sm:px-7">
              The last {requests.length} requests{errors ? <span className="text-rose"> · {errors} server error{errors === 1 ? "" : "s"}</span> : null}, newest first.
            </p>
          )}
          <TableHead columns={columns}>
            <span>Time (UTC)</span>
            <span>Status</span>
            <span>Request</span>
            <span className="text-right">Took</span>
            <span className="text-right">Size</span>
            <span>From</span>
          </TableHead>
          {requests === null && <Empty>Couldn&apos;t read the request log.</Empty>}
          {requests?.length === 0 && <Empty>No requests yet. Every visit to {project.slug}&apos;s domains shows up here.</Empty>}
          {requests?.map((r, i) => (
            <TableRow key={i} columns={columns} data-status={String(r.status)}>
              <span className="tabular-nums text-muted" title={new Date(r.at).toISOString()}>
                {new Date(r.at).toLocaleTimeString("en-GB", { timeZone: "UTC" })}
              </span>
              <span className="inline-flex items-center gap-2 tabular-nums">
                <StatusDot status={statusTone(r.status)} /> {r.status || "—"}
              </span>
              <span className="min-w-0 truncate font-mono text-[12.5px]" title={`${r.host}${r.uri}`}>
                <span className="text-muted">{r.method}</span> {r.uri}
              </span>
              <span className="text-right tabular-nums text-muted">{r.ms} ms</span>
              <span className="text-right tabular-nums text-muted">{size(r.bytes)}</span>
              <span className="truncate font-mono text-[12.5px] text-muted">{r.ip}</span>
            </TableRow>
          ))}
        </section>
      )}
    </>
  );
}

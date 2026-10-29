import { Database, HardDrive } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBytes } from "@/components/backup-list";
import { AddPostgresForm, AddRedisForm, RemovePostgresForm, RemoveRedisForm, SecretUrl } from "@/components/services";
import { Card, StatusDot } from "@/components/ui";
import { listBackups } from "@/lib/backup/runner";
import { getProjectBySlug } from "@/lib/projects";
import { serviceStatus } from "@/lib/services";
import { PageBody, PageHeader } from "@/components/page";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Databases" };

const NOTICES: Record<string, string> = {
  "redis-added": "Redis is running.",
  "redis-removed": "Redis removed.",
  "postgres-added": "Postgres is ready.",
  "postgres-removed": "Postgres removed, and its data deleted.",
  "postgres-removed-kept": "Postgres removed. A final dump is kept on the server in /var/lib/layer-agent/archive.",
};

export default async function DatabasesPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ notice?: string; restart?: string }> }) {
  await requireUser();
  const { notice, restart } = await searchParams;
  const project = getProjectBySlug((await params).slug);
  if (!project) notFound();
  const status = await serviceStatus(project.slug).catch(() => null);
  const lastBackup = listBackups({ slug: project.slug, limit: 10 }).find((b) => b.status === "ok");
  const sqlite = lastBackup?.contents?.sqlite ?? [];
  const redis = status?.redis;
  const postgres = status?.postgres;

  return (
    <>
      <PageHeader
        title="Databases"
        subtitle={project.slug}
      />
      <PageBody>
        <p className="text-[13px] text-muted">Each one belongs to this app alone: its own credentials, running as the app&apos;s user, backed up with its data.</p>

      {notice && NOTICES[notice] && (
        <p className="rounded-2xl border border-accent/40 bg-accent/5 px-4 py-3 text-[14px]" data-testid="notice">
          {NOTICES[notice]}{" "}
          {restart && /^\d+$/.test(restart) ? (
            <>
              Restarting {project.slug} on the same build so it gets the new connection URL:{" "}
              <Link href={`/projects/${project.slug}/deployments/${restart}`} className="font-medium underline underline-offset-4">
                deployment #{restart}
              </Link>
              .
            </>
          ) : (
            "The app gets the change with its next deploy."
          )}
        </p>
      )}

      <section className="grid gap-3">
        <h2 className="flex items-center gap-2 text-[17px] font-bold tracking-tight">
          <HardDrive className="size-4 text-muted" aria-hidden /> SQLite
        </h2>
        <Card className="grid gap-3 p-5 text-[13px]">
          <p>
            Keep SQLite files in <code className="font-mono">DATA_DIR</code> (<code className="font-mono">/srv/apps/{project.slug}/data</code>). It&apos;s the one folder the app can write that survives deploys. Backups find every database there and copy it safely, even while the app writes.
          </p>
          {sqlite.length > 0 && (
            <ul className="divide-y divide-border rounded-md border border-border">
              {sqlite.map((f) => (
                <li key={f.path} className="flex items-center justify-between px-3 py-2 font-mono text-[12px]">
                  {f.path}
                  <span className="text-muted tabular-nums">{formatBytes(f.bytes)}</span>
                </li>
              ))}
            </ul>
          )}
          {sqlite.length > 0 && <p className="text-[12px] text-muted">As of the last backup.</p>}
        </Card>
      </section>

      <section className="grid gap-3">
        <h2 className="flex items-center gap-2 text-[17px] font-bold tracking-tight">
          <Database className="size-4 text-muted" aria-hidden /> Postgres
        </h2>
        <Card className="grid gap-4 p-5" data-testid="postgres-card">
          {status && !postgres && (
            <>
              <p className="text-[13px] text-muted">
                A database and role just for this app on the server&apos;s PostgreSQL (installed the first time, tuned for small boxes). No other app&apos;s role can connect to it. The app gets <code className="font-mono">DATABASE_URL</code>, and every backup includes a <code className="font-mono">pg_dump</code>.
              </p>
              <AddPostgresForm slug={project.slug} installed={status.installed.postgres} />
            </>
          )}
          {postgres && (
            <>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px]">
                <span className="inline-flex items-center gap-2 font-medium">
                  <StatusDot status={postgres.answering ? "ok" : "err"} /> {postgres.answering ? "Running" : "Not answering"}
                </span>
                <span className="font-mono text-[12px] text-muted">{postgres.database}</span>
                {postgres.sizeMb !== null && <span className="text-muted tabular-nums">{postgres.sizeMb} MB</span>}
              </div>
              <div className="grid gap-1.5">
                <p className="text-[12px] font-medium">DATABASE_URL</p>
                <SecretUrl url={postgres.url} />
              </div>
              <div>
                <RemovePostgresForm slug={project.slug} />
              </div>
            </>
          )}
          {!status && <p className="text-[13px] text-err">Couldn&apos;t ask the agent about this app&apos;s services.</p>}
        </Card>
      </section>

      <section className="grid gap-3">
        <h2 className="flex items-center gap-2 text-[17px] font-bold tracking-tight">
          <Database className="size-4 text-muted" aria-hidden /> Redis
        </h2>
        <Card className="grid gap-4 p-5" data-testid="redis-card">
          {!status && <p className="text-[13px] text-err">Couldn&apos;t ask the agent about this app&apos;s services.</p>}
          {status && !redis && (
            <>
              <p className="text-[13px] text-muted">
                A Redis just for this app, on 127.0.0.1 with its own password and memory cap. The app gets <code className="font-mono">REDIS_URL</code>. Its data lives in <code className="font-mono">data/redis</code>, so it&apos;s in the backups.
              </p>
              <AddRedisForm slug={project.slug} installed={status.installed.redis} />
            </>
          )}
          {redis && (
            <>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px]">
                <span className="inline-flex items-center gap-2 font-medium">
                  <StatusDot status={redis.answering ? "ok" : "err"} /> {redis.answering ? "Running" : redis.active ? "Not answering" : "Stopped"}
                </span>
                <span className="text-muted tabular-nums">
                  {redis.memoryUsedMb ?? "?"} / {redis.memoryMb} MB
                </span>
                <span className="text-muted tabular-nums">port {redis.port}</span>
              </div>
              <div className="grid gap-1.5">
                <p className="text-[12px] font-medium">REDIS_URL</p>
                <SecretUrl url={redis.url} />
              </div>
              <div>
                <RemoveRedisForm slug={project.slug} />
              </div>
            </>
          )}
        </Card>
      </section>
      </PageBody>
    </>
  );
}

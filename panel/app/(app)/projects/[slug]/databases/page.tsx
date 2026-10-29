import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBytes } from "@/components/backup-list";
import { Dot, KeyValues, Notice, PageHeader, SettingsRow } from "@/components/page";
import { AddPostgresForm, AddRedisForm, RemovePostgresForm, RemoveRedisForm, SecretUrl } from "@/components/services";
import { StatusText } from "@/components/status";
import { listBackups } from "@/lib/backup/runner";
import { getProjectBySlug } from "@/lib/projects";
import { serviceStatus } from "@/lib/services";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Databases" };

const NOTICES: Record<string, { lead: string; tone: "ok" | "lav"; text: string }> = {
  "redis-added": { lead: "Added", tone: "ok", text: "Redis is running." },
  "redis-removed": { lead: "Removed", tone: "lav", text: "Redis removed." },
  "postgres-added": { lead: "Added", tone: "ok", text: "Postgres is ready." },
  "postgres-removed": { lead: "Removed", tone: "lav", text: "Postgres removed, and its data deleted." },
  "postgres-removed-kept": { lead: "Removed", tone: "lav", text: "Postgres removed. A final dump is kept on the server in /var/lib/layer-agent/archive." },
};

const Unreachable = () => <p className="text-[13px] text-rose">Couldn&apos;t ask the agent about this app&apos;s services.</p>;

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
  const n = notice ? NOTICES[notice] : undefined;

  return (
    <>
      <PageHeader title={project.slug} crumb="Databases" meta="Only this app can reach these" />
      {/* The only Notice on this page: it says what an add or remove just did. */}
      {n && (
        <Notice lead={n.lead} tone={n.tone}>
          {n.text}{" "}
          {restart && /^\d+$/.test(restart) ? (
            <>
              Restarting {project.slug} on the same build so it gets the new connection URL:{" "}
              <Link href={`/projects/${project.slug}/deployments/${restart}`} className="text-lavender hover:underline">
                deployment #{restart}
              </Link>
              .
            </>
          ) : (
            "The app gets the change with its next deploy."
          )}
        </Notice>
      )}

      <SettingsRow title="PostgreSQL" description="A database and role only this app can use, on the server's PostgreSQL. Every backup includes a pg_dump.">
        <div className="grid gap-4" data-testid="postgres-card">
          {!status && <Unreachable />}
          {status && !postgres && (
            <>
              <p className="text-[13.5px] text-muted">
                Installed the first time and tuned for small boxes. The app gets <code className="font-mono text-[12.5px]">DATABASE_URL</code>.
              </p>
              <AddPostgresForm slug={project.slug} installed={status.installed.postgres} />
            </>
          )}
          {postgres && (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-muted">
                <StatusText status={postgres.answering ? "ok" : "err"} label={postgres.answering ? "Running" : "Not answering"} />
                <Dot />
                <code className="font-mono text-[12.5px]">{postgres.database}</code>
                {postgres.sizeMb !== null && (
                  <>
                    <Dot />
                    <span className="tabular-nums">{postgres.sizeMb} MB</span>
                  </>
                )}
              </div>
              <div className="grid gap-1.5">
                <p className="text-[13px] font-medium">DATABASE_URL</p>
                <SecretUrl url={postgres.url} />
              </div>
              <RemovePostgresForm slug={project.slug} />
            </>
          )}
        </div>
      </SettingsRow>

      <SettingsRow title="Redis" description="Its own small Redis on 127.0.0.1, with a password and a memory cap. Its data lives in data/redis, so it's in the backups.">
        <div className="grid gap-4" data-testid="redis-card">
          {!status && <Unreachable />}
          {status && !redis && (
            <>
              <p className="text-[13.5px] text-muted">
                The app gets <code className="font-mono text-[12.5px]">REDIS_URL</code>. Pick how much memory it may use.
              </p>
              <AddRedisForm slug={project.slug} installed={status.installed.redis} />
            </>
          )}
          {redis && (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-muted">
                <StatusText status={redis.answering ? "ok" : "err"} label={redis.answering ? "Running" : redis.active ? "Not answering" : "Stopped"} />
                <Dot />
                <span className="tabular-nums">
                  {redis.memoryUsedMb ?? "?"} of {redis.memoryMb} MB used
                </span>
                <Dot />
                <span className="tabular-nums">port {redis.port}</span>
              </div>
              <div className="grid gap-1.5">
                <p className="text-[13px] font-medium">REDIS_URL</p>
                <SecretUrl url={redis.url} />
              </div>
              <RemoveRedisForm slug={project.slug} />
            </>
          )}
        </div>
      </SettingsRow>

      <SettingsRow title="SQLite" description="Keep database files in DATA_DIR, the one folder the app can write that survives deploys. Backups find them and copy them safely, even while the app writes.">
        <KeyValues
          inset
          items={[
            ["DATA_DIR", <code key="d" className="font-mono text-[13px]">/srv/apps/{project.slug}/data</code>],
            [
              "Found",
              sqlite.length ? (
                <span key="f" className="grid gap-1">
                  {sqlite.map((f) => (
                    <span key={f.path}>
                      <code className="font-mono text-[13px]">{f.path}</code> <span className="text-muted tabular-nums">· {formatBytes(f.bytes)} · checked</span>
                    </span>
                  ))}
                  <span className="text-[12.5px] text-dim">As of the last backup</span>
                </span>
              ) : (
                <span key="f" className="text-muted">
                  {lastBackup ? "No SQLite files in the last backup" : "Shown after the first backup"}
                </span>
              ),
            ],
          ]}
        />
      </SettingsRow>
    </>
  );
}

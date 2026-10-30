import Link from "next/link";
import { notFound } from "next/navigation";
import { formatBytes } from "@/components/backup-list";
import { Dot, KeyValues, Notice, PageHeader, SettingsRow } from "@/components/page";
import { AddDatabaseForm, AddRedisForm, InstallMongodbForm, RemoveDatabaseForm, RemoveRedisForm, SecretUrl, SecretValue } from "@/components/services";
import { StatusText } from "@/components/status";
import { listBackups } from "@/lib/backup/runner";
import { boxConfig } from "@/lib/box";
import { getProjectBySlug } from "@/lib/projects";
import { serviceStatus, type DatabaseKind, type ServiceStatus } from "@/lib/services";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Databases" };

// quiet: nothing about the app changed, so no word about restarting it.
const NOTICES: Record<string, { lead: string; tone: "ok" | "lav"; text: string; quiet?: boolean }> = {
  "redis-added": { lead: "Added", tone: "ok", text: "Redis is running." },
  "redis-removed": { lead: "Removed", tone: "lav", text: "Redis removed." },
  "postgres-added": { lead: "Added", tone: "ok", text: "Postgres is ready." },
  "postgres-removed": { lead: "Removed", tone: "lav", text: "Postgres removed, and its data deleted." },
  "postgres-removed-kept": { lead: "Removed", tone: "lav", text: "Postgres removed. A final dump is kept on the server in /var/lib/layer-agent/archive." },
  "mysql-added": { lead: "Added", tone: "ok", text: "MySQL is ready." },
  "mysql-removed": { lead: "Removed", tone: "lav", text: "MySQL removed, and its data deleted." },
  "mysql-removed-kept": { lead: "Removed", tone: "lav", text: "MySQL removed. A final dump is kept on the server in /var/lib/layer-agent/archive." },
  "mongodb-installed": { lead: "Installed", tone: "ok", text: "MongoDB is running on this server, shared by every project. Create this project's database and user below.", quiet: true },
  "mongodb-added": { lead: "Added", tone: "ok", text: "This project's MongoDB database and user are ready." },
  "mongodb-removed": { lead: "Removed", tone: "lav", text: "MongoDB removed, and its data deleted." },
  "mongodb-removed-kept": { lead: "Removed", tone: "lav", text: "MongoDB removed. A final dump is kept on the server in /var/lib/layer-agent/archive." },
};

const DATABASES = {
  postgres: {
    title: "PostgreSQL",
    label: "Postgres",
    env: "DATABASE_URL",
    description: "A database and role only this app can use, on the server's PostgreSQL. Every backup includes a pg_dump.",
    first: "Installed the first time and tuned for small boxes.",
  },
  mysql: {
    title: "MySQL",
    label: "MySQL",
    env: "DATABASE_URL",
    description: "A database and user only this app can use, on the server's MariaDB, the MySQL that comes with Ubuntu and Debian. Every backup includes a dump.",
    first: "Installed the first time and tuned for small boxes.",
  },
  mongodb: {
    title: "MongoDB",
    label: "MongoDB",
    env: "MONGODB_URI",
    description: "One MongoDB on this server, shared by every project. This project gets its own database and a user with its own password. Every backup includes a mongodump.",
    first: "MongoDB is installed on this server. Create a database and a user, with its own password, only this project can use.",
  },
} as const;

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
  const n = notice ? NOTICES[notice] : undefined;

  return (
    <>
      <PageHeader title={project.slug} crumb="Databases" meta="Only this app can reach these" />
      {/* The only Notice on this page: it says what an add or remove just did. */}
      {n && (
        <Notice lead={n.lead} tone={n.tone}>
          {n.text}{" "}
          {n.quiet ? null : restart && /^\d+$/.test(restart) ? (
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

      <DatabaseRow kind="postgres" slug={project.slug} status={status} />
      <DatabaseRow kind="mysql" slug={project.slug} status={status} />
      <DatabaseRow kind="mongodb" slug={project.slug} status={status} />

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

/**
 * Postgres, MySQL or MongoDB: add it, or see it and remove it. An app gets one
 * SQL database (both use DATABASE_URL); MongoDB's MONGODB_URI fits next to either.
 */
function DatabaseRow({ kind, slug, status }: { kind: DatabaseKind; slug: string; status: ServiceStatus | null }) {
  const d = DATABASES[kind];
  const db = status?.[kind];
  const other = kind === "postgres" ? "mysql" : kind === "mysql" ? "postgres" : null;
  const taken = other !== null && status?.[other] !== undefined;
  // MongoDB is installed on its own first, once for every project.
  const needsServer = kind === "mongodb" && status !== null && !status.installed.mongodb;
  return (
    <SettingsRow title={d.title} description={d.description}>
      <div className="grid gap-4" data-testid={`${kind}-card`}>
        {!status && <Unreachable />}
        {status && !db && taken && (
          <p className="text-[13.5px] text-muted">
            {slug} uses {DATABASES[other].label}. An app gets one SQL database, since both give it <code className="font-mono text-[12.5px]">DATABASE_URL</code>.
          </p>
        )}
        {status && !db && needsServer && (
          <>
            <p className="text-[13.5px] text-muted">MongoDB isn&apos;t installed on this server yet. It&apos;s installed once and every project shares it, each with its own database and user.</p>
            <InstallMongodbForm slug={slug} />
          </>
        )}
        {status && !db && !taken && !needsServer && (
          <>
            <p className="text-[13.5px] text-muted">
              {d.first} The app gets <code className="font-mono text-[12.5px]">{d.env}</code>.
            </p>
            <AddDatabaseForm slug={slug} kind={kind} installed={status.installed[kind]} />
          </>
        )}
        {db && (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-muted">
              <StatusText status={db.answering ? "ok" : "err"} label={db.answering ? "Running" : "Not answering"} />
              <Dot />
              <code className="font-mono text-[12.5px]">{db.database}</code>
              {db.sizeMb !== null && (
                <>
                  <Dot />
                  <span className="tabular-nums">{db.sizeMb} MB</span>
                </>
              )}
            </div>
            {kind === "mongodb" && <MongoLogin url={db.url} />}
            <div className="grid gap-1.5">
              <p className="text-[13px] font-medium">{d.env}</p>
              <SecretUrl url={db.url} />
              {kind === "mongodb" && (
                <p className="text-[12.5px] text-dim">
                  To open it from your computer (Compass, mongosh), tunnel the port first:{" "}
                  <code className="font-mono text-[12px] text-muted">ssh -N -L 27017:127.0.0.1:27017 root@{boxConfig().publicIp}</code>, then use the same URI.
                </p>
              )}
            </div>
            <RemoveDatabaseForm slug={slug} kind={kind} />
          </>
        )}
      </div>
    </SettingsRow>
  );
}

/** The pieces of the project's MongoDB login, for tools that ask for them one by one. */
function MongoLogin({ url }: { url: string }) {
  const u = new URL(url);
  return (
    <KeyValues
      inset
      items={[
        ["Host", <code key="h" className="font-mono text-[13px]">{u.host}</code>],
        ["Database", <code key="d" className="font-mono text-[13px]">{u.pathname.slice(1)}</code>],
        ["Username", <code key="u" className="font-mono text-[13px]">{decodeURIComponent(u.username)}</code>],
        ["Password", <SecretValue key="p" value={decodeURIComponent(u.password)} />],
      ]}
    />
  );
}

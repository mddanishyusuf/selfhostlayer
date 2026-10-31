import Link from "next/link";
import type { ReactNode } from "react";
import { AddDatabaseDialog, DatabaseMenu, type AddOption } from "@/components/databases";
import { ENGINE_LOOK } from "@/components/engines";
import { Icon } from "@/components/icon";
import { Empty, Notice, PageHeader, PillLink, Section, TileIcon } from "@/components/page";
import { InstallMongodbForm } from "@/components/services";
import { StatusChip } from "@/components/status";
import { browse, type BrowseResult, type Engine } from "@/lib/browse";
import { listProjects } from "@/lib/projects";
import { engines, serviceStatus, type Engines, type ServiceStatus } from "@/lib/services";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Databases" };

/** One database of one app, as a row in Every app's databases. */
interface Row {
  engine: Engine;
  slug: string;
  name: string;
  /** The viewer's db= parameter. */
  db: string;
  url?: string;
  /** Its size, and how many tables, collections or keys. */
  meta: (string | null)[];
  answering: boolean;
}

/** 212 MB, 6.2 MB, 340 KB. */
function size(mb: number | null): string | null {
  if (mb === null) return null;
  if (mb < 1) return `${Math.max(1, Math.round(mb * 1024))} KB`;
  return mb < 10 ? `${Math.round(mb * 10) / 10} MB` : `${Math.round(mb)} MB`;
}

const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;
const count = (n: number | null | undefined, one: string) => (typeof n === "number" ? plural(n, one) : null);

/** An app's databases: its SQLite files first, then those on the shared servers. */
function rowsOf(slug: string, s: ServiceStatus | null, files: NonNullable<BrowseResult["files"]>): Row[] {
  const rows: Row[] = files.map((f) => ({ engine: "sqlite", slug, name: `data/${f.path}`, db: `sqlite:${f.path}`, meta: [size(f.bytes / 1048576), count(f.tables, "table")], answering: true }));
  if (s?.postgres) rows.push({ engine: "postgres", slug, name: s.postgres.database, db: "postgres", url: s.postgres.url, meta: [size(s.postgres.sizeMb), count(s.postgres.tables, "table")], answering: s.postgres.answering });
  if (s?.mysql) rows.push({ engine: "mysql", slug, name: s.mysql.database, db: "mysql", url: s.mysql.url, meta: [size(s.mysql.sizeMb), count(s.mysql.tables, "table")], answering: s.mysql.answering });
  if (s?.mongodb) rows.push({ engine: "mongodb", slug, name: s.mongodb.database, db: "mongodb", url: s.mongodb.url, meta: [size(s.mongodb.sizeMb), count(s.mongodb.collections, "collection")], answering: s.mongodb.answering });
  if (s?.redis) {
    const r = s.redis;
    rows.push({ engine: "redis", slug, name: `redis-${slug}`, db: "redis", url: r.url, meta: [r.memoryUsedMb === null ? null : `${r.memoryUsedMb} of ${r.memoryMb} MB`, count(r.keys, "key")], answering: r.answering });
  }
  return rows;
}

/** An engine in the Engines card: what it is, how much of it the apps use, and whether it runs. On phones the usage goes under the name. */
function EngineRow({ engine, title, children, chip, foot }: { engine: Engine; title: string; children: ReactNode; chip: ReactNode; foot: ReactNode }) {
  const look = ENGINE_LOOK[engine];
  return (
    <div className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border-t border-border-soft px-3.5 py-2.5 first:border-t-0 md:grid-cols-[32px_minmax(0,1fr)_auto_110px]" data-testid={`engine-${engine}`}>
      <TileIcon tone={look.tone} size="sm">
        <Icon icon={look.icon} size={17} />
      </TileIcon>
      <div className="grid min-w-0 gap-0.5">
        <b className="font-bold">{title}</b>
        <p className="text-[12px] text-muted">{children}</p>
      </div>
      <div className="col-span-2 col-start-2 flex flex-wrap items-center gap-2.5 text-[12px] text-muted md:col-auto md:justify-end">{foot}</div>
      <div className="col-start-3 row-start-1 justify-self-end md:col-auto md:row-auto md:justify-self-start">{chip}</div>
    </div>
  );
}

function DatabaseRow({ row, label }: { row: Row; label: string }) {
  const look = ENGINE_LOOK[row.engine];
  return (
    <div className="group px-3.5 transition-colors duration-150 hover:bg-hover" data-testid="database">
      <div className="grid grid-cols-[32px_minmax(0,1fr)_auto_auto] items-center gap-x-3 border-t border-border-soft py-2.5 group-first:border-t-0">
        <TileIcon tone={look.tone} size="sm">
          <Icon icon={look.icon} size={17} />
        </TileIcon>
        <Link href={`/projects/${row.slug}/databases`} className="grid min-w-0 gap-0.5">
          <code className="truncate font-mono text-[13px] font-bold">{row.name}</code>
          <span className="text-[12px] text-muted sm:truncate">
            {[row.slug, label, ...row.meta].filter(Boolean).join(" · ")}
            {!row.answering && <span className="text-rose"> · not answering</span>}
          </span>
        </Link>
        <PillLink href={`/projects/${row.slug}/databases/view?db=${encodeURIComponent(row.db)}`} size="sm">
          Browse
        </PillLink>
        <DatabaseMenu slug={row.slug} url={row.url} />
      </div>
    </div>
  );
}

export default async function DatabasesOverviewPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  await requireUser();
  const { notice } = await searchParams;
  const apps = listProjects().filter((p) => p.runtime.kind !== "static");
  const [server, statuses, sqlite] = await Promise.all([
    engines().catch((): Engines | null => null),
    Promise.all(apps.map((p) => serviceStatus(p.slug).catch(() => null))),
    // Each app's SQLite files, found as the app's own user (no job when its data folder is empty).
    Promise.all(apps.map((p) => browse(p.slug, { engine: "sqlite", op: "tables" }).then((r) => r.files ?? [], () => []))),
  ]);
  const installed = server?.installed ?? statuses.find((s) => s)?.installed ?? { redis: false, postgres: false, mysql: false, mongodb: false };
  const running = server?.running ?? { postgres: false, mysql: false, mongodb: false };
  const versions = server?.versions;
  const rows = apps.flatMap((p, i) => rowsOf(p.slug, statuses[i] ?? null, sqlite[i] ?? []));
  const of = (engine: Engine) => rows.filter((r) => r.engine === engine);
  const label = (engine: Engine) => {
    const v = engine === "postgres" ? versions?.postgres : engine === "redis" ? versions?.redis : engine === "mongodb" ? versions?.mongodb : null;
    return v ? `${ENGINE_LOOK[engine].name} ${v}` : ENGINE_LOOK[engine].name;
  };
  const known = statuses.filter((s): s is ServiceStatus => s !== null);
  const sum = (list: (number | null)[]) => list.reduce<number>((n, mb) => n + (mb ?? 0), 0);
  const down = rows.filter((r) => !r.answering);

  const serverChip = (on: boolean, up: boolean) => (!on ? <StatusChip status="idle" label="Not installed" /> : up ? <StatusChip status="ok" label="Running" /> : <StatusChip status="err" label="Stopped" />);
  const usage = (mb: number, apps: number) => `${size(mb)} · ${plural(apps, "app")}`;
  const later = <span className="text-dim">Installed the first time an app asks for one</span>;
  const redisRows = of("redis");

  const options: AddOption[] = [
    { kind: "postgres", apps: known.filter((s) => !s.postgres && !s.mysql).map((s) => s.slug), installed: installed.postgres },
    { kind: "redis", apps: known.filter((s) => !s.redis).map((s) => s.slug), installed: installed.redis },
    {
      kind: "mongodb",
      apps: known.filter((s) => !s.mongodb).map((s) => s.slug),
      installed: installed.mongodb,
      blocked: !installed.mongodb ? "Install MongoDB first, from its card on this page." : !running.mongodb ? "MongoDB is stopped: start it from its card." : undefined,
    },
    { kind: "mysql", apps: known.filter((s) => !s.postgres && !s.mysql).map((s) => s.slug), installed: installed.mysql },
  ];

  return (
    <>
      <PageHeader title="Databases" meta="Native, no Docker · one per app" actions={<AddDatabaseDialog options={options} />} />
      {notice === "mongodb-installed" && (
        <Notice lead="Installed" tone="ok">
          MongoDB is running on this server. Add a database to an app with Add a database, or from the app&apos;s Databases page.
        </Notice>
      )}
      {down.length > 0 && (
        <Notice lead="Not answering" tone="err">
          {[...new Set(down.map((r) => r.slug))].join(", ")}: check the project&apos;s Databases page.
        </Notice>
      )}

      <Section title="Engines" description="Every app gets its own login and can't see the others.">
        <div className="pb-1.5">
          <EngineRow engine="sqlite" title="SQLite" chip={<StatusChip status="ok" label="Built in" />} foot={plural(of("sqlite").length, "file")}>
            Files in each app&apos;s data folder, backed up with their -wal and -shm.
          </EngineRow>
          <EngineRow engine="postgres" title={label("postgres")} chip={serverChip(installed.postgres, running.postgres)} foot={installed.postgres ? usage(sum(known.map((s) => s.postgres?.sizeMb ?? null)), of("postgres").length) : later}>
            One server, a role and database per app.
          </EngineRow>
          <EngineRow
            engine="redis"
            title={label("redis")}
            chip={!installed.redis ? <StatusChip status="idle" label="Not installed" /> : redisRows.some((r) => !r.answering) ? <StatusChip status="err" label="Not answering" /> : <StatusChip status={redisRows.length ? "ok" : "idle"} label={redisRows.length ? "Running" : "Installed"} />}
            foot={installed.redis ? plural(redisRows.length, "app") : later}
          >
            One Redis per app, with its own password and memory cap.
          </EngineRow>
          <EngineRow
            engine="mongodb"
            title={label("mongodb")}
            chip={serverChip(installed.mongodb, running.mongodb)}
            foot={!installed.mongodb ? <InstallMongodbForm compact /> : !running.mongodb ? <InstallMongodbForm compact start /> : usage(sum(known.map((s) => s.mongodb?.sizeMb ?? null)), of("mongodb").length)}
          >
            One shared server, a user per app that sees only its own database.
          </EngineRow>
          <EngineRow engine="mysql" title="MySQL (MariaDB)" chip={serverChip(installed.mysql, running.mysql)} foot={installed.mysql ? usage(sum(known.map((s) => s.mysql?.sizeMb ?? null)), of("mysql").length) : later}>
            One server, a user and database per app.
          </EngineRow>
        </div>
      </Section>

      <Section title="Every app's databases">
        {rows.length === 0 ? (
          <Empty>No databases yet. Add one with Add a database. SQLite files in an app&apos;s data folder show up here on their own.</Empty>
        ) : (
          <div className="pb-1.5">
            {rows.map((r) => (
              <DatabaseRow key={`${r.slug}/${r.db}`} row={r} label={label(r.engine)} />
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

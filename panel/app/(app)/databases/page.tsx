import { ArrowUpRight01Icon, Database01Icon, HardDriveIcon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import type { ReactNode } from "react";
import { Collapsible } from "@/components/collapsible";
import { CopyButton } from "@/components/form";
import { Icon } from "@/components/icon";
import { Dot, Notice, PageHeader, Section, TileIcon } from "@/components/page";
import { StatusText } from "@/components/status";
import { Mark, Pill } from "@/components/ui";
import { agent } from "@/lib/agent";
import { listBackups } from "@/lib/backup/runner";
import { listProjects } from "@/lib/projects";
import { serviceStatus, type ServiceStatus } from "@/lib/services";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Databases" };

function Instance({ slug, index, name, detail, ok, url }: { slug: string; index: number; name: string; detail: ReactNode; ok: boolean; url?: string }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3.5 border-t border-border py-3.5 pl-4 pr-4 sm:pr-7 md:pl-[82px]">
      <Mark name={slug} index={index} size="sm" />
      <div className="grid min-w-0 gap-0.5">
        <div className="flex min-w-0 items-center gap-2 text-[15px] font-semibold">
          {slug} <code className="truncate font-mono text-[13px] font-normal text-muted">{name}</code>
        </div>
        <div className="truncate text-[13px] text-muted">{detail}</div>
      </div>
      <div className="flex items-center gap-2">
        <span className="max-sm:hidden">{ok ? <StatusText status="ok" label="Answering" /> : <StatusText status="err" label="Not answering" />}</span>
        {url && <CopyButton text={url} label="Copy URL" />}
        <Link href={`/projects/${slug}/databases`} title={`Open ${slug}`} className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-foreground">
          <Icon icon={ArrowUpRight01Icon} size={16} />
        </Link>
      </div>
    </div>
  );
}

function Footer({ add, note }: { add?: ReactNode; note: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border py-3 pl-4 pr-4 text-[13px] sm:pr-7 md:pl-[82px]">
      {add}
      <span className="ml-auto text-dim">{note}</span>
    </div>
  );
}

export default async function DatabasesOverviewPage() {
  await requireUser();
  const all = listProjects();
  const apps = all.filter((p) => p.runtime.kind !== "static");
  const statuses = (await Promise.all(apps.map((p) => serviceStatus(p.slug).catch(() => null)))).filter((s): s is ServiceStatus => s !== null);
  const installed = statuses[0]?.installed ?? (await agent<{ installed: ServiceStatus["installed"] }>("service.status").then((r) => r.installed).catch(() => ({ redis: false, postgres: false, mysql: false })));
  const indexOf = (slug: string) => all.findIndex((p) => p.slug === slug);
  const pg = statuses.filter((s) => s.postgres);
  const my = statuses.filter((s) => s.mysql);
  const redis = statuses.filter((s) => s.redis);
  // SQLite files as the last successful backup found them.
  const sqlite = apps
    .map((p) => ({ p, files: listBackups({ slug: p.slug, limit: 5 }).find((b) => b.status === "ok")?.contents?.sqlite ?? [] }))
    .filter((x) => x.files.length > 0);
  const down = [...pg.filter((s) => !s.postgres!.answering), ...my.filter((s) => !s.mysql!.answering), ...redis.filter((s) => !s.redis!.answering)];
  const total = pg.length + my.length + redis.length + sqlite.reduce((n, x) => n + x.files.length, 0);
  const withoutRedis = statuses.filter((s) => !s.redis).map((s) => s.slug);
  // An app gets one SQL database: those with Postgres can't add MySQL, and the other way round.
  const withoutSql = statuses.filter((s) => !s.postgres && !s.mysql).map((s) => s.slug);
  const addLinks = (engine: string, slugs: string[]) =>
    slugs.length ? (
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted">Add {engine} to</span>
        {slugs.map((slug) => (
          <Link key={slug} href={`/projects/${slug}/databases`} className="text-lavender hover:underline">
            {slug}
          </Link>
        ))}
      </span>
    ) : undefined;
  const pgMb = pg.reduce((n, s) => n + (s.postgres!.sizeMb ?? 0), 0);
  const myMb = my.reduce((n, s) => n + (s.mysql!.sizeMb ?? 0), 0);
  const redisUsed = redis.reduce((n, s) => n + (s.redis!.memoryUsedMb ?? 0), 0);
  const redisCap = redis.reduce((n, s) => n + s.redis!.memoryMb, 0);

  return (
    <>
      <PageHeader title="Databases" meta="Native, no Docker · one per app" />
      {down.length ? (
        <Notice lead="Not answering" tone="err">
          {down.map((s) => s.slug).join(", ")}: check the project&apos;s Databases page.
        </Notice>
      ) : total > 0 ? (
        <Notice lead="Healthy" tone="ok">
          All {total} database{total === 1 ? " is" : "s are"} answering.
        </Notice>
      ) : null}

      <Collapsible
        testId="engine-postgres"
        lead={<TileIcon tone="blue"><Icon icon={Database01Icon} size={20} /></TileIcon>}
        title={<>PostgreSQL {installed.postgres ? <Pill outline>Installed</Pill> : <Pill outline>Not installed</Pill>}</>}
        sub={installed.postgres ? <>{pg.length} database{pg.length === 1 ? "" : "s"}<Dot />{pgMb.toFixed(1)} MB</> : "Installed the first time you add it to a project"}
        side={installed.postgres ? <span className="max-sm:hidden"><StatusText status="ok" label="Running" /></span> : undefined}
      >
        {pg.map((s) => (
          <Instance key={s.slug} slug={s.slug} index={indexOf(s.slug)} name={s.postgres!.database} ok={s.postgres!.answering} url={s.postgres!.url} detail={<>{s.postgres!.sizeMb !== null ? `${s.postgres!.sizeMb} MB` : "size unknown"}<Dot />a pg_dump in every backup</>} />
        ))}
        <Footer add={addLinks("Postgres", withoutSql)} note="One server · a role and database per app · 127.0.0.1 only" />
      </Collapsible>

      <Collapsible
        testId="engine-mysql"
        lead={<TileIcon tone="teal"><Icon icon={Database01Icon} size={20} /></TileIcon>}
        title={<>MySQL {installed.mysql ? <Pill outline>Installed</Pill> : <Pill outline>Not installed</Pill>}</>}
        sub={installed.mysql ? <>{my.length} database{my.length === 1 ? "" : "s"}<Dot />{myMb.toFixed(1)} MB<Dot />MariaDB</> : "MariaDB, installed the first time you add it to a project"}
        side={installed.mysql ? <span className="max-sm:hidden"><StatusText status="ok" label="Running" /></span> : undefined}
      >
        {my.map((s) => (
          <Instance key={s.slug} slug={s.slug} index={indexOf(s.slug)} name={s.mysql!.database} ok={s.mysql!.answering} url={s.mysql!.url} detail={<>{s.mysql!.sizeMb !== null ? `${s.mysql!.sizeMb} MB` : "size unknown"}<Dot />a dump in every backup</>} />
        ))}
        <Footer add={addLinks("MySQL", withoutSql)} note="One server · a user and database per app · 127.0.0.1 only" />
      </Collapsible>

      <Collapsible
        testId="engine-redis"
        lead={<TileIcon tone="coral"><Icon icon={Database01Icon} size={20} /></TileIcon>}
        title={<>Redis {installed.redis ? <Pill outline>Installed</Pill> : <Pill outline>Not installed</Pill>}</>}
        sub={installed.redis ? <>{redis.length} instance{redis.length === 1 ? "" : "s"}<Dot />{redisUsed} MB used of {redisCap} MB</> : "Installed the first time you add it to a project"}
        side={installed.redis ? <span className="max-sm:hidden"><StatusText status="ok" label="Running" /></span> : undefined}
      >
        {redis.map((s) => (
          <Instance key={s.slug} slug={s.slug} index={indexOf(s.slug)} name={`port ${s.redis!.port}`} ok={s.redis!.answering} url={s.redis!.url} detail={<>{s.redis!.memoryUsedMb ?? "?"} MB of {s.redis!.memoryMb} MB<Dot />noeviction</>} />
        ))}
        <Footer add={addLinks("Redis", withoutRedis)} note="One small Redis per app · its own password and memory cap" />
      </Collapsible>

      <Collapsible
        testId="engine-sqlite"
        lead={<TileIcon tone="lav"><Icon icon={HardDriveIcon} size={20} /></TileIcon>}
        title={<>SQLite <Pill outline>Built in</Pill></>}
        sub={<>{sqlite.length} app{sqlite.length === 1 ? "" : "s"} with SQLite files<Dot />checked at every backup</>}
      >
        {sqlite.flatMap(({ p, files }) =>
          files.map((f) => <Instance key={`${p.slug}/${f.path}`} slug={p.slug} index={indexOf(p.slug)} name={f.path} ok detail={<>{(f.bytes / 1048576).toFixed(1)} MB<Dot />integrity ok at the last backup</>} />),
        )}
        <Footer note="Files in each app's DATA_DIR are found by their header and copied safely, even while the app writes" />
      </Collapsible>

      <Section title="More engines" description="Installed the first time an app asks for one.">
        {[["MongoDB", "Document data. Not in Ubuntu's packages; it needs MongoDB's own repository.", "dim"]].map(([name, what, tone]) => (
          <div key={name} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3.5 border-t border-border px-4 py-3.5 sm:px-7">
            <TileIcon tone={tone as "teal" | "dim"}>
              <Icon icon={Database01Icon} size={20} />
            </TileIcon>
            <div className="grid min-w-0 gap-0.5">
              <b className="text-[15px] font-semibold">{name}</b>
              <span className="truncate text-[13px] text-muted">{what}</span>
            </div>
            <Pill outline>Coming soon</Pill>
          </div>
        ))}
      </Section>
    </>
  );
}

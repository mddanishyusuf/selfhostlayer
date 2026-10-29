import { Database, HardDrive, Leaf, Plus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageBody, PageHeader } from "@/components/page";
import { StatusDot, cx } from "@/components/ui";
import { agent } from "@/lib/agent";
import { listProjects } from "@/lib/projects";
import { serviceStatus, type ServiceStatus } from "@/lib/services";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Databases" };

function Engine({ icon, name, status, children, soon }: { icon: ReactNode; name: string; status: ReactNode; children?: ReactNode; soon?: boolean }) {
  return (
    <section className={cx("overflow-hidden rounded-2xl border border-border", soon && "border-dashed")}>
      <div className="flex items-center gap-3 px-4 py-4 sm:px-5">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-subtle">{icon}</span>
        <div className="grid min-w-0 flex-1">
          <h2 className="text-[17px] font-bold">{name}</h2>
          <p className="text-[13px] text-muted">{status}</p>
        </div>
        {soon && <span className="rounded-full border border-border-strong px-2.5 py-0.5 text-[12px] font-bold text-muted">Soon</span>}
      </div>
      {children && <div className="divide-y divide-border border-t border-border">{children}</div>}
    </section>
  );
}

function Instance({ href, project, detail, ok }: { href: string; project: string; detail: string; ok: boolean }) {
  return (
    <Link href={href} className="flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-subtle sm:px-5">
      <StatusDot status={ok ? "ok" : "err"} />
      <span className="text-[15px] font-bold">{project}</span>
      <span className="ml-auto truncate text-[13px] text-muted tabular-nums">{detail}</span>
    </Link>
  );
}

function AddTo({ engine, slugs }: { engine: string; slugs: string[] }) {
  if (slugs.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-5">
      <span className="text-[13px] text-muted">Add {engine} to</span>
      {slugs.map((slug) => (
        <Link key={slug} href={`/projects/${slug}/databases`} className="inline-flex h-7 items-center gap-1 rounded-full border border-border-strong px-3 text-[13px] font-bold transition-colors duration-150 hover:bg-hover">
          <Plus className="size-3.5" aria-hidden /> {slug}
        </Link>
      ))}
    </div>
  );
}

export default async function DatabasesOverviewPage() {
  await requireUser();
  const projects = listProjects().filter((p) => p.runtime.kind !== "static");
  const statuses = (await Promise.all(projects.map((p) => serviceStatus(p.slug).catch(() => null)))).filter((s): s is ServiceStatus => s !== null);
  const installed = statuses[0]?.installed ?? (await agent<{ installed: ServiceStatus["installed"] }>("service.status").then((r) => r.installed).catch(() => ({ redis: false, postgres: false })));
  const pg = statuses.filter((s) => s.postgres);
  const redis = statuses.filter((s) => s.redis);
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

  return (
    <>
      <PageHeader title="Databases" subtitle="Each app gets its own database and credentials, running natively on this server" />
      <PageBody className="gap-4">
        <Engine icon={<Database className="size-5" aria-hidden />} name="PostgreSQL" status={installed.postgres ? `Installed · ${count(pg.length, "database")}` : "Installed the first time you add it to a project"}>
          {pg.map((s) => (
            <Instance key={s.slug} href={`/projects/${s.slug}/databases`} project={s.slug} detail={`${s.postgres!.database}${s.postgres!.sizeMb !== null ? ` · ${s.postgres!.sizeMb} MB` : ""}`} ok={s.postgres!.answering} />
          ))}
          <AddTo engine="Postgres" slugs={statuses.filter((s) => !s.postgres).map((s) => s.slug)} />
        </Engine>

        <Engine icon={<Database className="size-5 text-err" aria-hidden />} name="Redis" status={installed.redis ? `Installed · ${count(redis.length, "instance")}, one per app` : "Installed the first time you add it to a project"}>
          {redis.map((s) => (
            <Instance key={s.slug} href={`/projects/${s.slug}/databases`} project={s.slug} detail={`port ${s.redis!.port} · ${s.redis!.memoryUsedMb ?? "?"} / ${s.redis!.memoryMb} MB`} ok={s.redis!.answering} />
          ))}
          <AddTo engine="Redis" slugs={statuses.filter((s) => !s.redis).map((s) => s.slug)} />
        </Engine>

        <Engine icon={<HardDrive className="size-5" aria-hidden />} name="SQLite" status="Built in: keep database files in each app's DATA_DIR. Backups copy them safely and check them." />

        <Engine icon={<Leaf className="size-5 text-ok" aria-hidden />} name="MongoDB" status="Not in Ubuntu's packages; it needs MongoDB's own repository." soon />
        <Engine icon={<Database className="size-5 text-accent" aria-hidden />} name="MySQL / MariaDB" status="For apps that need it, like Ghost." soon />
      </PageBody>
    </>
  );
}

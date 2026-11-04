import { RefreshCwIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { deleteEmailSync, runEmailSync } from "@/app/actions/email";
import { SyncMappingForm } from "@/components/email-sync";
import { when } from "@/components/email-ui";
import { Icon } from "@/components/icon";
import { CARD, Empty, Notice, PageHeader, SettingsRow, TableHead, TableRow } from "@/components/page";
import { StatusDot, buttonClass, cx } from "@/components/ui";
import { browse, type Engine } from "@/lib/browse";
import { brandFor, emailInstall, listsOf } from "@/lib/email";
import { listSyncs, pagingColumn, projectDatabases, SYNC_ENGINES, type EmailSync } from "@/lib/email-sync";
import { getProject, listProjects } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sync from an app" };

const COLUMNS = "16px minmax(220px,1.5fr) minmax(140px,1fr) minmax(160px,1fr) 72px";
const iconButton = "grid size-8 place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground";
const SELECT = "select-pill h-[35px] min-w-[220px] border border-border bg-field pl-2.5 pr-8 outline-none focus:border-accent";

function lastRun(s: EmailSync): { dot: "ok" | "warn" | "err" | "idle"; text: string } {
  if (s.running) return { dot: "warn", text: "Syncing now…" };
  const r = s.lastResult;
  if (!r || !s.lastRunAt) return { dot: "idle", text: "Not synced yet" };
  if (r.error) return { dot: "err", text: `Failed ${when(s.lastRunAt)}: ${r.error}` };
  const parts = [`${r.created.toLocaleString("en")} new`];
  if (r.refused) parts.push(`${r.refused.toLocaleString("en")} refused`);
  if (r.flagged) parts.push(`${r.flagged.toLocaleString("en")} flagged`);
  return { dot: "ok", text: `${when(s.lastRunAt)}: ${r.read.toLocaleString("en")} rows read, ${parts.join(", ")}` };
}

type Search = { project?: string; db?: string; table?: string };

export default async function SyncPage({ params, searchParams }: { params: Promise<{ brand: string }>; searchParams: Promise<Search> }) {
  await requireUser();
  const ctx = await brandFor((await params).brand);
  if (!ctx) return null;
  const { project: emailProject, brand } = ctx;
  const sp = await searchParams;
  const path = `/email/${brand.id}/sync`;
  const syncs = listSyncs(brand.id);
  let lists: { id: number; name: string }[] = [];
  let problem: string | null = null;
  try {
    lists = await listsOf(emailProject, brand.id);
  } catch (err) {
    problem = (err as Error).message;
  }
  const install = emailInstall();
  // Your apps: not Email itself, and not static sites (no database).
  const projects = listProjects().filter((p) => p.id !== install?.id && p.runtime.kind !== "static");

  // The picker, a step at a time: project, then database, then table, then columns.
  const picked = sp.project ? projects.find((p) => p.slug === sp.project) : undefined;
  const databases = picked ? await projectDatabases(picked.slug) : [];
  const db = sp.db ? databases.find((d) => `${d.engine}:${d.file ?? ""}` === sp.db) : undefined;
  let tables: { name: string; rows: number | null }[] = [];
  let pickProblem: string | null = null;
  if (picked && db) {
    try {
      tables = ((await browse(picked.slug, { engine: db.engine, op: "tables", file: db.file ?? undefined })).tables ?? []).filter((t) => db.engine === "mongodb" || t.type === "table" || t.type === "view");
    } catch (err) {
      pickProblem = (err as Error).message;
    }
  }
  let sample: Awaited<ReturnType<typeof browse>>["result"] | undefined;
  if (picked && db && sp.table && tables.some((t) => t.name === sp.table)) {
    try {
      sample = (await browse(picked.slug, { engine: db.engine, op: "rows", file: db.file ?? undefined, table: sp.table, limit: 3 })).result;
    } catch (err) {
      pickProblem = (err as Error).message;
    }
  }
  const columns = sample?.columns ?? [];
  const guess = { email: columns.find((c) => /^e?-?mail(_?address)?$/i.test(c)) ?? columns.find((c) => /mail/i.test(c)) ?? null, name: columns.find((c) => /^(full_?)?name$/i.test(c)) ?? columns.find((c) => /name/i.test(c) && !/user_?name/i.test(c)) ?? null };

  return (
    <>
      <PageHeader title={brand.name} crumb="Sync from an app" meta="Sign-ups and leads in your projects' databases, into a list" />
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      {syncs.length > 0 && (
        <section className={CARD} data-testid="sync-list">
          <TableHead columns={COLUMNS}>
            <span />
            <span>Source</span>
            <span>Into</span>
            <span>Last sync</span>
            <span />
          </TableHead>
          {syncs.map((s) => {
            const p = getProject(s.projectId);
            const run = lastRun(s);
            return (
              <TableRow key={s.id} columns={COLUMNS} data-testid="sync">
                <StatusDot status={run.dot} pulse={s.running} />
                <span className="grid min-w-0 gap-px">
                  <b className="truncate">{p?.slug ?? "deleted project"}</b>
                  <span className="truncate font-mono text-[12px] text-muted">
                    {s.engine === "sqlite" ? `data/${s.file}` : s.engine} · {s.table} · {s.emailColumn}
                  </span>
                </span>
                <span className="truncate text-muted max-md:hidden">{lists.find((l) => l.id === s.listId)?.name ?? "No list"}</span>
                <span className={cx("truncate text-[12px]", run.dot === "err" ? "text-rose" : "text-muted")} title={`In all: ${s.totals.read.toLocaleString("en")} rows read, ${s.totals.created.toLocaleString("en")} contacts added, ${s.totals.refused.toLocaleString("en")} refused by Shield`} data-testid="sync-status">
                  {run.text}
                </span>
                <span className="flex justify-end gap-0.5">
                  <form action={runEmailSync}>
                    <input type="hidden" name="id" value={s.id} />
                    <button type="submit" title="Sync now" className={iconButton} disabled={s.running}>
                      <Icon icon={RefreshCwIcon} size={15} />
                      <span className="sr-only">Sync now</span>
                    </button>
                  </form>
                  <form action={deleteEmailSync}>
                    <input type="hidden" name="id" value={s.id} />
                    <button type="submit" title="Stop syncing (contacts stay)" className={iconButton}>
                      <Icon icon={Trash2Icon} size={15} />
                      <span className="sr-only">Stop syncing</span>
                    </button>
                  </form>
                </span>
              </TableRow>
            );
          })}
        </section>
      )}
      <SettingsRow
        title={syncs.length ? "Add another source" : "Add a source"}
        description="A table in one of your projects' databases with an email column, like users or leads. It's read as the app itself, read-only, through the database viewer: no password leaves the server."
      >
        <div className="grid gap-4" data-testid="sync-picker">
          <form action={path} className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-[13px]">
              <span className="font-medium">Project</span>
              <select name="project" defaultValue={picked?.slug ?? ""} className={SELECT}>
                <option value="">Pick a project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.slug}>
                    {p.slug}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={buttonClass("secondary")}>
              Next
            </button>
          </form>
          {picked && (
            <form action={path} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="project" value={picked.slug} />
              {databases.length ? (
                <>
                  <label className="grid gap-1 text-[13px]">
                    <span className="font-medium">Database</span>
                    <select name="db" defaultValue={sp.db ?? ""} className={SELECT}>
                      <option value="">Pick a database</option>
                      {databases
                        .filter((d) => SYNC_ENGINES.includes(d.engine as Engine))
                        .map((d) => (
                          <option key={`${d.engine}:${d.file ?? ""}`} value={`${d.engine}:${d.file ?? ""}`}>
                            {d.label}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button type="submit" className={buttonClass("secondary")}>
                    Next
                  </button>
                </>
              ) : (
                <p className="text-[13px] text-muted">
                  {picked.slug} has no database: no SQLite file in its data folder, and no Postgres, MySQL or MongoDB.{" "}
                  <Link href={`/projects/${picked.slug}/databases`} className="text-accent hover:underline">
                    Its Databases page
                  </Link>
                </p>
              )}
            </form>
          )}
          {picked && db && (
            <form action={path} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="project" value={picked.slug} />
              <input type="hidden" name="db" value={sp.db} />
              {tables.length ? (
                <>
                  <label className="grid gap-1 text-[13px]">
                    <span className="font-medium">{db.engine === "mongodb" ? "Collection" : "Table"}</span>
                    <select name="table" defaultValue={sp.table ?? ""} className={SELECT}>
                      <option value="">Pick one</option>
                      {tables.map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.name}
                          {t.rows !== null ? ` (${t.rows.toLocaleString("en")} rows)` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" className={buttonClass("secondary")}>
                    Next
                  </button>
                </>
              ) : (
                <p className="text-[13px] text-muted">{pickProblem ?? "No tables in it yet."}</p>
              )}
            </form>
          )}
          {picked && db && sp.table && sample && (
            <>
              {sample.rows.length > 0 && (
                <div className="overflow-x-auto border border-border">
                  <table className="w-full text-left text-[12px]">
                    <thead className="text-muted">
                      <tr>
                        {columns.map((c) => (
                          <th key={c} className="whitespace-nowrap border-b border-border px-2.5 py-1.5 font-mono font-normal">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sample.rows.map((r, i) => (
                        <tr key={i}>
                          {r.map((v, j) => (
                            <td key={j} className="max-w-[220px] truncate whitespace-nowrap border-b border-border-soft px-2.5 py-1.5 font-mono">
                              {v === null ? "" : typeof v === "object" ? ("text" in v ? v.text : "…") : String(v)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <SyncMappingForm brandId={brand.id} project={picked.slug} db={sp.db!} table={sp.table} columns={columns} guess={guess} cursorColumn={pagingColumn(sample)} lists={lists} />
            </>
          )}
          {pickProblem && sample === undefined && tables.length > 0 && <p className="text-[13px] text-rose">{pickProblem}</p>}
          {!projects.length && <Empty>No projects with a database yet.</Empty>}
        </div>
      </SettingsRow>
    </>
  );
}

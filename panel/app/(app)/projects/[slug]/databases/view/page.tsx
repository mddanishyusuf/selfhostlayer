import { ChevronLeftIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DataGrid, QueryBox } from "@/components/data-grid";
import { EditableRows } from "@/components/db-editor";
import { Icon } from "@/components/icon";
import { CARD, Empty, Notice, PageHeader, PillLink, Segmented } from "@/components/page";
import { QueryBuilder } from "@/components/query-builder";
import { NO_AUTOFILL, buttonClass, cx } from "@/components/ui";
import { canBackUpEdits } from "@/lib/backup/runner";
import { browse, ENGINES, isSql, PAGE_SIZE, parseDb, parseWhere, type BrowseResult } from "@/lib/browse";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Database" };

/**
 * db: which database; t: the table, collection or key; q: the query; s, d:
 * sort column and direction; p: page; w: the visual builder's filters (JSON);
 * m: "sql" for the SQL box instead of the builder (SQL databases only).
 */
type Search = { db?: string; t?: string; q?: string; s?: string; d?: string; p?: string; w?: string; m?: string };

const size = (bytes: number) => (bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

export default async function DatabaseViewPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Search> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project) notFound();
  const sp = await searchParams;
  const target = parseDb(sp.db);
  if (!target) redirect(`/projects/${project.slug}/databases`);
  const { engine, file } = target;
  const e = ENGINES[engine];
  const base = `/projects/${project.slug}/databases/view`;
  const href = (next: Partial<Search>) => {
    const all: Search = { db: sp.db, t: sp.t, q: sp.q, s: sp.s, d: sp.d, w: sp.w, m: sp.m, ...next };
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(all)) if (v) u.set(k, v);
    return `${base}?${u}`;
  };
  const page = Math.max(1, Math.floor(Number(sp.p)) || 1);
  const q = sp.q?.trim() ?? "";
  const table = sp.t || undefined;
  const picking = engine === "sqlite" && !file;
  // SQL databases open on the visual builder; the SQL box is a tab (m=sql), and a query in the URL means it.
  const sqlMode = isSql(engine) && (sp.m === "sql" || (!!q && sp.m !== "builder"));
  const where = isSql(engine) && !sqlMode ? parseWhere(sp.w) : undefined;
  // SQL: a query stands alone, or a table's rows. MongoDB: a filter runs on a collection. Redis: a pattern narrows the keys, and a key shows its value.
  const op = picking ? "tables" : engine === "redis" ? (table ? "rows" : q ? "query" : "tables") : q && (sqlMode || (!isSql(engine) && table)) ? "query" : table ? "rows" : "tables";
  const queried = op === "query" && isSql(engine);
  let data: BrowseResult | null = null;
  let error: string | null = null;
  try {
    data = await browse(project.slug, {
      engine,
      file,
      op,
      table: queried ? undefined : table,
      query: (sqlMode || !isSql(engine)) && q ? q : undefined,
      offset: (page - 1) * PAGE_SIZE,
      limit: PAGE_SIZE,
      sort: sp.s,
      desc: sp.d === "1",
      where: op === "rows" ? where : undefined,
    });
  } catch (err) {
    error = (err as Error).message;
    // Still list what's in the database when a query or a page fails.
    data = await browse(project.slug, { engine, file, op: "tables", query: engine === "redis" ? q || undefined : undefined }).catch(() => null);
  }
  if (picking && data?.files?.length === 1) redirect(href({ db: `sqlite:${data.files[0]!.path}` }));

  const result = data?.result;
  const tables = data?.tables ?? [];
  // Sorting a table's rows or a collection: by a column, then the other way, then not at all.
  const sortable = result && !queried && engine !== "redis";
  const sortLinks = sortable ? result.columns.map((c) => href({ s: sp.s === c && sp.d === "1" ? undefined : c, d: sp.s === c && sp.d !== "1" ? "1" : undefined, p: undefined })) : undefined;
  const paged = result && !queried && result.total !== null;
  const from = (page - 1) * PAGE_SIZE + 1;
  const editing = !!result && !queried && isSql(engine) && !!result.editable && !!result.schema && !!table;
  const backedUp = canBackUpEdits();

  return (
    <>
      <PageHeader
        back={`/projects/${project.slug}/databases`}
        title={project.slug}
        crumb={file ? `${e.label} · ${file}` : e.label}
        meta={isSql(engine) ? (backedUp ? "Edits are backed up first" : "Edits can't be undone: no backup storage") : "Read-only"}
      />
      <div className={cx(CARD, "grid md:min-h-[calc(100dvh-110px)]", !picking && "md:grid-cols-[248px_minmax(0,1fr)]")}>
        <aside className={cx("min-w-0 border-b border-border md:border-b-0 md:border-r", picking && "hidden")} data-testid="db-tables">
          {engine === "redis" && (
            <form action={base} className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <input type="hidden" name="db" value={sp.db} />
              <Icon icon={SearchIcon} size={15} className="text-dim" />
              <input {...NO_AUTOFILL} name="q" defaultValue={q} placeholder="Key pattern, like session:*" aria-label="Key pattern" spellCheck={false} className="h-8 min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:font-sans placeholder:text-dim" />
            </form>
          )}
          {!picking && (
            <>
              <div className="flex items-center justify-between px-4 pb-1.5 pt-4 text-[12px] font-medium text-dim">
                <span>{e.tables}</span>
                <span className="tabular-nums">
                  {tables.length}
                  {data?.more ? "+" : ""}
                </span>
              </div>
              <nav className="grid max-h-[38vh] content-start overflow-y-auto pb-3 md:max-h-[calc(100dvh-130px)]">
                {tables.map((t) => (
                  <Link
                    key={t.name}
                    href={href({ t: t.name, q: engine === "redis" ? sp.q : undefined, s: undefined, d: undefined, p: undefined, w: undefined, m: undefined })}
                    className={cx("flex items-center gap-2 px-4 py-[7px] transition-colors duration-150 hover:bg-hover", t.name === table && !queried ? "bg-selected text-foreground" : "text-muted")}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{t.name}</span>
                    {t.type !== e.table && <span className="text-[11.5px] text-dim">{t.type}</span>}
                    {t.rows !== null && <span className="text-[12px] tabular-nums text-dim">{t.rows.toLocaleString()}</span>}
                  </Link>
                ))}
                {data && !tables.length && <p className="px-4 py-1.5 text-[12px] text-muted">{engine === "redis" && q ? "No keys match." : `No ${e.tables.toLowerCase()} yet.`}</p>}
              </nav>
              {data?.more && <p className="px-4 pb-4 text-[12px] text-dim">The first 500 keys. A pattern narrows them.</p>}
            </>
          )}
        </aside>

        <section className="min-w-0">
          {!picking && isSql(engine) && (
            <div className="grid gap-3 border-b border-border px-3.5 py-3">
              <Segmented
                items={[
                  { href: href({ m: undefined, q: undefined, p: undefined }), label: "Builder", active: !sqlMode },
                  { href: href({ m: "sql", w: undefined, p: undefined }), label: "SQL", active: sqlMode },
                ]}
              />
              {sqlMode ? (
                <form action={base} className="grid gap-2" data-testid="db-query">
                  <input type="hidden" name="db" value={sp.db} />
                  <input type="hidden" name="m" value="sql" />
                  <QueryBox name="q" defaultValue={q} lines={q.split("\n").length > 2 ? 6 : 2} placeholder={`SELECT * FROM ${table ?? tables[0]?.name ?? "table"} LIMIT 20`} />
                  <QueryActions clear={q ? href({ q: undefined, t: undefined }) : undefined} note="Read-only · one statement · 500 rows at most" />
                </form>
              ) : (
                <QueryBuilder
                  key={`${table ?? ""}|${sp.w ?? ""}`}
                  tables={tables.map((t) => t.name)}
                  table={table}
                  columns={result && !queried ? result.columns : []}
                  where={where}
                  base={base}
                  db={sp.db!}
                />
              )}
            </div>
          )}
          {engine === "mongodb" && table && (
            <form action={base} className="grid gap-2 border-b border-border px-3.5 py-3" data-testid="db-query">
              <input type="hidden" name="db" value={sp.db} />
              <input type="hidden" name="t" value={table} />
              <QueryBox name="q" defaultValue={q} lines={1} placeholder={'Filter, like {"status": "active"} or {"_id": {"$oid": "…"}}'} />
              <QueryActions clear={q ? href({ q: undefined }) : undefined} note="A JSON filter for find()" />
            </form>
          )}
          {error && (
            <Notice lead="Couldn't run it" tone="err">
              {error}
            </Notice>
          )}

          {picking ? (
            <FilePicker files={data?.files} base={base} slug={project.slug} />
          ) : result ? (
            <>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-border px-3.5 py-2.5 text-[12px] text-muted">
                {queried ? <b className="font-medium text-foreground">Query</b> : <code className="font-mono text-[12.5px] text-foreground">{table}</code>}
                <span>·</span>
                <span className="tabular-nums">
                  {queried ? `${result.rows.length.toLocaleString()}${result.truncated ? "+" : ""} rows` : `${(result.total ?? result.rows.length).toLocaleString()} ${engine === "redis" ? "items" : "rows"}`}
                </span>
                {engine === "redis" && result.ttl !== undefined && (
                  <>
                    <span>·</span>
                    <span>{result.ttl === -1 ? "No expiry" : result.ttl >= 0 ? `Expires in ${result.ttl.toLocaleString()} s` : "Gone"}</span>
                  </>
                )}
                <span className="ml-auto text-[12px] tabular-nums text-dim">{result.ms} ms</span>
              </div>
              {editing && result.rows.length ? (
                <EditableRows
                  key={`${table}|${sp.w ?? ""}|${page}|${sp.s ?? ""}|${sp.d ?? ""}`}
                  slug={project.slug}
                  db={sp.db!}
                  table={table!}
                  columns={result.columns}
                  rows={result.rows}
                  schema={result.schema!}
                  keys={result.key ?? null}
                  total={result.total ?? result.rows.length}
                  where={where}
                  firstRow={from}
                  sortLinks={sortLinks}
                  sorted={sortable && sp.s ? { column: sp.s, desc: sp.d === "1" } : undefined}
                />
              ) : result.rows.length ? (
                <DataGrid columns={result.columns} rows={result.rows} firstRow={queried ? 1 : from} sortLinks={sortLinks} sorted={sortable && sp.s ? { column: sp.s, desc: sp.d === "1" } : undefined} />
              ) : (
                <p className="px-3.5 py-10 text-center text-[12px] text-muted">No rows.</p>
              )}
              {(paged || result.truncated) && (
                <div className="flex flex-wrap items-center gap-3 border-t border-border px-3.5 py-2.5 text-[12px] text-muted">
                  {paged && result.rows.length > 0 && (
                    <span className="tabular-nums">
                      Rows {from.toLocaleString()}–{(from + result.rows.length - 1).toLocaleString()} of {result.total!.toLocaleString()}
                    </span>
                  )}
                  {result.truncated && <span className="text-gold">{queried ? "Showing the first rows; LIMIT and OFFSET show others." : "Some rows are too large to show at once."}</span>}
                  {paged && (
                    <span className="ml-auto flex gap-2">
                      {page > 1 && (
                        <PillLink href={href({ p: String(page - 1) })} size="sm">
                          <Icon icon={ChevronLeftIcon} size={14} /> Previous
                        </PillLink>
                      )}
                      {from + result.rows.length - 1 < result.total! && (
                        <PillLink href={href({ p: String(page + 1) })} size="sm">
                          Next <Icon icon={ChevronRightIcon} size={14} />
                        </PillLink>
                      )}
                    </span>
                  )}
                </div>
              )}
            </>
          ) : (
            data && (
              <Empty>
                {tables.length ? (engine === "redis" ? "Pick a key to see its value." : isSql(engine) ? `Pick a ${e.table}, or run a query.` : `Pick a ${e.table}.`) : `Nothing in this database yet.`}
              </Empty>
            )
          )}
        </section>
      </div>
    </>
  );
}

function QueryActions({ clear, note }: { clear?: string; note: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="submit" className={buttonClass("primary", "sm")}>
        Run
      </button>
      {clear && (
        <PillLink href={clear} size="sm">
          Clear
        </PillLink>
      )}
      <span className="ml-auto text-[12px] text-dim">
        {note} · <kbd className="font-sans">⌘↵</kbd>
      </span>
    </div>
  );
}

/** SQLite: the databases found in the data folder, by their header. */
function FilePicker({ files, base, slug }: { files?: { path: string; bytes: number }[]; base: string; slug: string }) {
  if (!files) return null;
  if (!files.length)
    return (
      <Empty>
        No SQLite databases in <code className="font-mono text-[13px]">/srv/apps/{slug}/data</code> yet.
      </Empty>
    );
  return (
    <div data-testid="db-files">
      <p className="border-b border-border px-3.5 py-2.5 text-[12px] text-muted">SQLite databases in the data folder</p>
      {files.map((f) => (
        <Link key={f.path} href={`${base}?db=${encodeURIComponent(`sqlite:${f.path}`)}`} className="flex items-center gap-3 border-b border-border px-3.5 py-3 transition-colors duration-150 hover:bg-hover">
          <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{f.path}</code>
          <span className="text-[12px] tabular-nums text-dim">{size(f.bytes)}</span>
        </Link>
      ))}
    </div>
  );
}

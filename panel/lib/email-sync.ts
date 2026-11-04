// Email's Sync from an app (PLAN-EMAIL-2.md): sign-ups and leads in one of
// your projects' databases, into a brand's list. A source names a table, its
// email column, optionally its name column and up to 10 more as fields, and
// the list. It's read through the database viewer's job (db.browse), as the
// app's own user with its own logins, 200 rows at a time: after the last
// primary key it read when the table has one, else all of it again (contacts
// already there are only updated). Email checks every page with Shield and
// adds it like an import: nobody who left is resubscribed. The monitor runs
// each source every 15 minutes; Sync now runs one at once.
import { agent } from "./agent";
import { browse, type BrowseResult, type Cell, type Engine } from "./browse";
import { db, now } from "./db";
import { emailApi, emailInstall } from "./email";
import { getProject } from "./projects";

export interface EmailSync {
  id: number;
  brandId: number;
  projectId: number;
  engine: Engine;
  file: string | null;
  table: string;
  emailColumn: string;
  nameColumn: string | null;
  fieldColumns: string[];
  listId: number | null;
  /** Paged by this column's values (the primary key), or null: read whole each time. */
  cursorColumn: string | null;
  cursor: string | null;
  running: boolean;
  lastRunAt: number | null;
  lastResult: SyncResult | null;
  totals: { read: number; created: number; refused: number; flagged: number };
  createdAt: number;
}

export interface SyncResult {
  read: number;
  created: number;
  updated: number;
  refused: number;
  flagged: number;
  skipped: number;
  ms: number;
  error: string | null;
}

interface Row {
  id: number;
  brand_id: number;
  project_id: number;
  engine: Engine;
  file: string | null;
  source_table: string;
  email_column: string;
  name_column: string | null;
  field_columns: string;
  list_id: number | null;
  cursor_column: string | null;
  cursor: string | null;
  running: number;
  last_run_at: number | null;
  last_result: string | null;
  totals: string;
  created_at: number;
}

const fromRow = (r: Row): EmailSync => ({
  id: r.id,
  brandId: r.brand_id,
  projectId: r.project_id,
  engine: r.engine,
  file: r.file,
  table: r.source_table,
  emailColumn: r.email_column,
  nameColumn: r.name_column,
  fieldColumns: JSON.parse(r.field_columns) as string[],
  listId: r.list_id,
  cursorColumn: r.cursor_column,
  cursor: r.cursor,
  running: r.running === 1,
  lastRunAt: r.last_run_at,
  lastResult: r.last_result ? (JSON.parse(r.last_result) as SyncResult) : null,
  totals: { read: 0, created: 0, refused: 0, flagged: 0, ...(JSON.parse(r.totals) as object) },
  createdAt: r.created_at,
});

export const SYNC_EVERY_MS = 15 * 60_000;
const PAGE = 200;
/** One run reads at most this many rows; the next run carries on (paged by key) or starts over. */
const MAX_ROWS = 50_000;
export const SYNC_ENGINES: Engine[] = ["sqlite", "postgres", "mysql", "mongodb"];

export const listSyncs = (brandId: number): EmailSync[] => (db().prepare("SELECT * FROM email_syncs WHERE brand_id = ? ORDER BY id").all(brandId) as unknown as Row[]).map(fromRow);
export function getSync(id: number): EmailSync | null {
  const r = db().prepare("SELECT * FROM email_syncs WHERE id = ?").get(id) as Row | undefined;
  return r ? fromRow(r) : null;
}

/** A field's name in Email, from a column's: lowercase letters, digits and _ (signup_date). */
export const fieldName = (column: string) =>
  column
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "f_$1")
    .slice(0, 40) || "field";

export function addSync(input: { brandId: number; projectId: number; engine: Engine; file: string | null; table: string; emailColumn: string; nameColumn: string | null; fieldColumns: string[]; listId: number | null; cursorColumn: string | null }): EmailSync {
  if (!SYNC_ENGINES.includes(input.engine)) throw new Error("Pick a SQLite, Postgres, MySQL or MongoDB database.");
  if (input.fieldColumns.length > 10) throw new Error("Up to 10 more columns.");
  if ((db().prepare("SELECT count(*) n FROM email_syncs WHERE brand_id = ?").get(input.brandId) as { n: number }).n >= 20) throw new Error("A brand can have up to 20 sources.");
  const id = Number(
    db()
      .prepare(
        `INSERT INTO email_syncs (brand_id, project_id, engine, file, source_table, email_column, name_column, field_columns, list_id, cursor_column, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.brandId, input.projectId, input.engine, input.file, input.table, input.emailColumn, input.nameColumn, JSON.stringify(input.fieldColumns), input.listId, input.cursorColumn, now()).lastInsertRowid,
  );
  return getSync(id)!;
}

export const deleteSync = (id: number) => db().prepare("DELETE FROM email_syncs WHERE id = ?").run(id);

/** A cell as text: numbers and booleans as written, long text whole as far as the viewer sent it. */
function text(c: Cell | undefined): string | null {
  if (c === null || c === undefined) return null;
  if (typeof c === "string") return c;
  if (typeof c === "number" || typeof c === "boolean") return String(c);
  if ("text" in c) return c.text;
  return null;
}

/** The single primary key column a table can be paged by, or null (none, several, or SQLite's hidden rowid). */
export function pagingColumn(result: BrowseResult["result"]): string | null {
  const key = result?.key?.columns ?? result?.schema?.filter((c) => c.pk).map((c) => c.name) ?? [];
  return key.length === 1 && key[0] !== "rowid" && result?.columns.includes(key[0]!) ? key[0]! : null;
}

/** Runs one source now: reads the new rows (or all of them) and sends them to Email page by page. */
export async function runSync(id: number): Promise<SyncResult> {
  const s = getSync(id);
  if (!s) throw new Error("No such source.");
  if (!db().prepare("UPDATE email_syncs SET running = 1 WHERE id = ? AND running = 0").run(id).changes) throw new Error("It's syncing already.");
  const started = Date.now();
  const result: SyncResult = { read: 0, created: 0, updated: 0, refused: 0, flagged: 0, skipped: 0, ms: 0, error: null };
  let cursor = s.cursor;
  try {
    const project = getProject(s.projectId);
    const email = emailInstall();
    if (!project) throw new Error("Its project was deleted.");
    if (!email) throw new Error("Email isn't installed.");
    for (let offset = 0; result.read < MAX_ROWS; ) {
      const page = await browse(project.slug, {
        engine: s.engine,
        op: "rows",
        file: s.file ?? undefined,
        table: s.table,
        limit: PAGE,
        ...(s.cursorColumn ? { sort: s.cursorColumn, ...(cursor !== null ? { where: { match: "all" as const, filters: [{ column: s.cursorColumn, op: "gt" as const, value: cursor }] } } : {}) } : { offset }),
      });
      const r = page.result;
      if (!r || !r.rows.length) break;
      const at = (column: string | null) => (column ? r.columns.indexOf(column) : -1);
      const emailAt = at(s.emailColumn);
      if (emailAt < 0) throw new Error(`${s.table} has no column ${s.emailColumn} any more.`);
      const nameAt = at(s.nameColumn);
      const fieldAt = s.fieldColumns.map((c) => [fieldName(c), at(c)] as const).filter(([, i]) => i >= 0);
      const rows = r.rows.map((row) => ({
        email: text(row[emailAt]) ?? "",
        name: nameAt >= 0 ? (text(row[nameAt]) ?? "") : "",
        fields: Object.fromEntries(fieldAt.map(([k, i]) => [k, (text(row[i]) ?? "").slice(0, 500)]).filter(([, v]) => v)),
      }));
      const added = await emailApi<{ created: number; updated: number; refused: number; flagged: number; skipped: unknown[] }>(email, `brands/${s.brandId}/sync`, {
        body: { rows, lists: s.listId ? [s.listId] : [], source: `sync:${project.slug}` },
        timeoutMs: 120_000,
      });
      result.read += r.rows.length;
      result.created += added.created;
      result.updated += added.updated;
      result.refused += added.refused;
      result.flagged += added.flagged;
      result.skipped += added.skipped.length - added.refused;
      if (s.cursorColumn) {
        const last = text(r.rows.at(-1)![at(s.cursorColumn)]);
        if (last === null) break;
        cursor = last;
        db().prepare("UPDATE email_syncs SET cursor = ? WHERE id = ?").run(cursor, id);
      } else offset += r.rows.length;
      // A short page is the last one (a page cut short for size isn't).
      if (r.rows.length < PAGE && !r.truncated) break;
    }
  } catch (err) {
    result.error = (err as Error).message;
  } finally {
    result.ms = Date.now() - started;
    const t = getSync(id)?.totals ?? s.totals;
    const totals = { read: t.read + result.read, created: t.created + result.created, refused: t.refused + result.refused, flagged: t.flagged + result.flagged };
    db().prepare("UPDATE email_syncs SET running = 0, last_run_at = ?, last_result = ?, totals = ? WHERE id = ?").run(Date.now(), JSON.stringify(result), JSON.stringify(totals), id);
  }
  return result;
}

/** The monitor's round: every source not run for 15 minutes, one after another, in the background. */
let syncing = false;
export async function syncDue(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    // A run the panel's restart cut off can't be running any more.
    const due = (db().prepare("SELECT id FROM email_syncs WHERE running = 0 AND (last_run_at IS NULL OR last_run_at < ?) ORDER BY id").all(Date.now() - SYNC_EVERY_MS) as { id: number }[]).map((r) => r.id);
    for (const id of due) await runSync(id).catch((err) => console.error(`email sync ${id}:`, (err as Error).message));
  } finally {
    syncing = false;
  }
}

/** At start: no run survives a restart. */
export function resetRunningSyncs(): void {
  db().prepare("UPDATE email_syncs SET running = 0 WHERE running = 1").run();
}

/** The databases a project has, for the source picker: its SQLite files and the services it uses. */
export async function projectDatabases(slug: string): Promise<{ engine: Engine; file: string | null; label: string }[]> {
  const out: { engine: Engine; file: string | null; label: string }[] = [];
  const sqlite = await browse(slug, { engine: "sqlite", op: "tables" }).catch(() => null);
  for (const f of sqlite?.files ?? []) out.push({ engine: "sqlite", file: f.path, label: `SQLite: data/${f.path}` });
  const services = await agent<{ postgres?: unknown; mysql?: unknown; mongodb?: unknown }>("service.status", { slug }).catch(() => ({}) as Record<string, unknown>);
  if (services.postgres) out.push({ engine: "postgres", file: null, label: "Postgres" });
  if (services.mysql) out.push({ engine: "mysql", file: null, label: "MySQL" });
  if (services.mongodb) out.push({ engine: "mongodb", file: null, label: "MongoDB" });
  return out;
}

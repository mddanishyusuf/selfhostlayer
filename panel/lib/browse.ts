// The database viewer, through the agent (db.browse): what's in one of an
// app's databases and a page of its rows (narrowed by the visual builder's
// filters), or a read-only query. The agent opens every engine read-only for
// this. Editing a SQL table's rows goes through db.count and db.update
// (countRows, updateRows), after a backup (app/actions/databases.ts).
import { agent } from "./agent";

export type Engine = "sqlite" | "postgres" | "mysql" | "mongodb" | "redis";

/** A value as the agent sends it: long text cut (with its full length), binary as a size, a field a document doesn't have. */
export type Cell = string | number | boolean | null | { bytes: number } | { text: string; length: number } | { missing: true };

export interface BrowseTable {
  name: string;
  /** table, view, collection, or a Redis type (string, hash, list…). */
  type: string;
  rows: number | null;
}

export interface BrowseResult {
  /** SQLite with no file picked: the databases found in the data folder, with their table counts (null if one can't be read). */
  files?: { path: string; bytes: number; tables?: number | null }[];
  tables: BrowseTable[];
  /** Redis: more keys than the 500 listed. */
  more?: boolean;
  result?: {
    columns: string[];
    rows: Cell[][];
    total: number | null;
    truncated: boolean;
    ms: number;
    ttl?: number;
    /** A SQL table's columns: their types, whether they take NULL, which make the primary key. */
    schema?: ColumnInfo[];
    /** A SQL table (not a view): its rows can be edited. */
    editable?: boolean;
    /** Each row's primary key (the rowid for a SQLite table without one), in row order; null when the table has none. */
    key?: RowKeys | null;
  };
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
}

export type KeyValue = string | number | null;
export interface RowKeys {
  columns: string[];
  rows: KeyValue[][];
}

// The visual query builder's filters live in where.ts (no server imports, so the builder can use them in the browser).
export { encodeWhere, FILTER_OPS, parseWhere, type Filter, type FilterOp, type Where } from "./where";
import type { Where } from "./where";

export const ENGINES: Record<Engine, { label: string; tables: string; table: string }> = {
  sqlite: { label: "SQLite", tables: "Tables", table: "table" },
  postgres: { label: "PostgreSQL", tables: "Tables", table: "table" },
  mysql: { label: "MySQL", tables: "Tables", table: "table" },
  mongodb: { label: "MongoDB", tables: "Collections", table: "collection" },
  redis: { label: "Redis", tables: "Keys", table: "key" },
};

export const PAGE_SIZE = 50;
export const isSql = (engine: Engine) => engine === "sqlite" || engine === "postgres" || engine === "mysql";

/** The db= search parameter: "postgres", or "sqlite:data/app.db" for one SQLite file. */
export function parseDb(value: string | undefined): { engine: Engine; file?: string } | null {
  if (!value) return null;
  const [engine, ...rest] = value.split(":");
  if (!engine || !(engine in ENGINES)) return null;
  const file = rest.join(":");
  if (engine !== "sqlite" && file) return null;
  return { engine: engine as Engine, file: file || undefined };
}

export function browse(slug: string, params: { engine: Engine; file?: string; op: "tables" | "rows" | "query"; table?: string; query?: string; offset?: number; limit?: number; sort?: string; desc?: boolean; where?: Where }) {
  return agent<BrowseResult>("db.browse", { slug, ...params });
}

// ---------------------------------------------------------------- Editing

/** Which rows an edit changes: picked in the grid (by key), the builder's filters, or all of them. */
export type EditTarget = { keys: RowKeys } | { where: Where } | { all: true };
export interface EditRequest {
  engine: "sqlite" | "postgres" | "mysql";
  file?: string;
  table: string;
  target: EditTarget;
}

/** How many rows an edit would change (read-only). */
export function countRows(slug: string, req: EditRequest) {
  return agent<{ matches: number }>("db.count", { slug, ...req });
}

/** Sets columns in the target rows, in one transaction, only if exactly `expect` rows match. */
export function updateRows(slug: string, req: EditRequest & { set: { column: string; value: string | null }[]; expect: number }) {
  return agent<{ updated: number }>("db.update", { slug, ...req });
}

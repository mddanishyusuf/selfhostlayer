// The database viewer, through the agent (db.browse): what's in one of an
// app's databases and a page of its rows, or a read-only query. Nothing here
// writes: the agent opens every engine read-only.
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
  /** SQLite with no file picked: the databases found in the data folder. */
  files?: { path: string; bytes: number }[];
  tables: BrowseTable[];
  /** Redis: more keys than the 500 listed. */
  more?: boolean;
  result?: { columns: string[]; rows: Cell[][]; total: number | null; truncated: boolean; ms: number; ttl?: number };
}

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

export function browse(slug: string, params: { engine: Engine; file?: string; op: "tables" | "rows" | "query"; table?: string; query?: string; offset?: number; limit?: number; sort?: string; desc?: boolean }) {
  return agent<BrowseResult>("db.browse", { slug, ...params });
}

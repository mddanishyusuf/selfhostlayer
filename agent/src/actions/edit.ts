// The database editor: change values in rows of one of an app's SQL tables
// (SQLite, Postgres or MySQL). db.count says how many rows a change would
// touch, read-only, for the confirmation; db.update makes it, in one
// transaction, and only if that many rows still match. Like the viewer, each
// call is one sandboxed job (edit-job.ts) as the app's own user with the
// app's own logins, so it can't reach further than the app itself.
//
// The panel takes a backup before it calls db.update; the agent only edits.
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { assertInt, assertLine, assertRelativePath, assertSlug, ValidationError } from "@layer/protocol";
import type { ActionTable, Context, Params } from "../context.ts";
import { EDIT_JOB } from "../edit-job.ts";
import { ActionError } from "../errors.ts";
import { lookupUser } from "../fsutil.ts";
import { sandboxArgs, SYSTEMD_RUN } from "../sandbox.ts";
import type { Where } from "../sql-where.ts";
import { appLayout } from "./app.ts";
import { assertValue, assertWhere } from "./browse.ts";
import { readServices } from "./service.ts";

const SQL_ENGINES = ["sqlite", "postgres", "mysql"] as const;
type SqlEngine = (typeof SQL_ENGINES)[number];
const NAMES: Record<SqlEngine, string> = { sqlite: "SQLite", postgres: "Postgres", mysql: "MySQL" };

type KeyValue = string | number | null;
/** Which rows: by primary key (rows picked in the grid), by the builder's filters, or every row. */
export type Target = { keys: { columns: string[]; rows: KeyValue[][] } } | { where: Where } | { all: true };

function assertTarget(value: unknown): Target {
  const t = (value ?? {}) as Record<string, unknown>;
  if (typeof value !== "object" || Array.isArray(value)) throw new ValidationError("target", "must say which rows: keys, where or all");
  const given = ["keys", "where", "all"].filter((k) => t[k] !== undefined);
  if (given.length !== 1) throw new ValidationError("target", "must say which rows: one of keys, where or all");
  if (t.all !== undefined) {
    if (t.all !== true) throw new ValidationError("target.all", "must be true");
    return { all: true };
  }
  if (t.where !== undefined) {
    const where = assertWhere(t.where);
    if (!where) throw new ValidationError("target.where", "must have at least one filter (use all for every row)");
    return { where };
  }
  const keys = (t.keys ?? {}) as Record<string, unknown>;
  if (!Array.isArray(keys.columns) || !keys.columns.length || keys.columns.length > 16) throw new ValidationError("target.keys.columns", "must name 1 to 16 key columns");
  const columns = keys.columns.map((c, i) => assertLine(c, `target.keys.columns[${i}]`, 256));
  if (!Array.isArray(keys.rows) || !keys.rows.length || keys.rows.length > 500) throw new ValidationError("target.keys.rows", "must list 1 to 500 rows");
  const rows = keys.rows.map((row, i) => {
    if (!Array.isArray(row) || row.length !== columns.length) throw new ValidationError(`target.keys.rows[${i}]`, `must have ${columns.length} values`);
    return row.map((v, j): KeyValue => {
      if (v === null || (typeof v === "number" && Number.isFinite(v))) return v;
      return assertValue(v, `target.keys.rows[${i}][${j}]`, 2000);
    });
  });
  return { keys: { columns, rows } };
}

/** The new values: up to 100 columns, each text or null (NULL). */
function assertSet(value: unknown): { column: string; value: string | null }[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new ValidationError("set", "must change 1 to 100 columns");
  const seen = new Set<string>();
  return value.map((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const column = assertLine(s.column, `set[${i}].column`, 256);
    if (seen.has(column)) throw new ValidationError(`set[${i}].column`, `sets ${column} twice`);
    seen.add(column);
    return { column, value: s.value === null ? null : assertValue(s.value, `set[${i}].value`, 1_000_000) };
  });
}

async function runEdit(params: Params, ctx: Context, mode: "count" | "apply") {
  const slug = assertSlug(params.slug);
  if (!SQL_ENGINES.includes(params.engine as SqlEngine)) throw new ValidationError("engine", `must be one of ${SQL_ENGINES.join(", ")}`);
  const engine = params.engine as SqlEngine;
  const app = appLayout(ctx, slug);
  if (!existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  const state = readServices(ctx, slug);
  if ((engine === "postgres" && !state.postgres) || (engine === "mysql" && !state.mysql)) throw new ActionError("not_found", `${slug} has no ${NAMES[engine]}`);
  let file: string | undefined;
  if (engine === "sqlite") {
    file = assertRelativePath(params.file, "file");
    const stat = lstatSync(join(app.data, file), { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new ActionError("not_found", `${file} isn't a file in ${slug}'s data folder`);
  }
  const table = assertLine(params.table, "table", 512);
  const target = assertTarget(params.target);
  const request = {
    engine,
    file,
    table,
    target,
    mode,
    set: mode === "apply" ? assertSet(params.set) : undefined,
    // The number of rows the user confirmed: anything else and nothing is written.
    expect: mode === "apply" ? assertInt(params.expect, "expect", 1, 10_000_000) : undefined,
  };

  const user = await lookupUser(ctx.exec, app.user);
  if (!user) throw new ActionError("not_found", `user ${app.user} doesn't exist`);
  let output = "";
  const { code } = await ctx.spawn(
    SYSTEMD_RUN,
    sandboxArgs({
      unit: `layer-edit-${slug}-${randomBytes(3).toString("hex")}.service`,
      user: user.name,
      cwd: app.data,
      readWrite: engine === "sqlite" ? [app.data] : [],
      env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
      envFiles: engine === "sqlite" ? [] : [join(app.etcDir, "services.env")],
      memoryMb: 512,
      timeoutSec: 120,
      network: engine === "sqlite" ? false : "localhost",
      command: [ctx.paths.runtimeNode, "--no-warnings", "-e", EDIT_JOB, JSON.stringify(request)],
    }),
    {
      onData: (chunk) => {
        if (output.length < 1024 * 1024) output += chunk;
      },
    },
  );
  const line = output.split("\n").find((l) => l.startsWith("LAYER-EDIT "));
  if (code !== 0 || !line) {
    const reason = output.split("\n").filter((l) => l.startsWith("layer: ")).at(-1)?.slice(7);
    throw new ActionError("edit_failed", reason ?? `the editor's job exited ${code}`);
  }
  return JSON.parse(line.slice("LAYER-EDIT ".length)) as { matches: number } | { updated: number };
}

/** The audit log keeps which table, columns and how many rows, never the values typed (they may be secrets). */
function redact(p: Params) {
  const target = (p.target ?? {}) as Record<string, unknown>;
  const keys = target.keys as { rows?: unknown[] } | undefined;
  const where = target.where as { filters?: { column?: unknown; op?: unknown }[] } | undefined;
  return {
    slug: p.slug,
    engine: p.engine,
    file: p.file,
    table: p.table,
    columns: Array.isArray(p.set) ? p.set.map((s) => (s as { column?: unknown }).column) : undefined,
    rows: keys ? (keys.rows?.length ?? 0) : where ? `filters on ${(where.filters ?? []).map((f) => `${String(f.column)} ${String(f.op)}`).join(", ")}` : target.all ? "all" : undefined,
    expect: p.expect,
  };
}

export const editActions: ActionTable = {
  "db.count": { mutates: false, run: (params, ctx) => runEdit(params, ctx, "count") },
  // The build lock (per app): an edit waits for that app's backup snapshot to finish.
  "db.update": { mutates: true, lock: "build", redact, run: (params, ctx) => runEdit(params, ctx, "apply") },
};

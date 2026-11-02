// The database viewer: what's in one of an app's databases (tables,
// collections or keys), a page of rows, or a read-only query. Each call is
// one sandboxed job (browse-job.ts) as the app's own user with the app's own
// logins, like a backup snapshot: the viewer sees no more than the app can,
// and every engine is opened read-only.
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertInt, assertLine, assertRelativePath, assertSlug, ValidationError } from "@layer/protocol";
import { BROWSE_JOB } from "../browse-job.ts";
import type { ActionTable, Context, Params } from "../context.ts";
import { ActionError } from "../errors.ts";
import { lookupUser } from "../fsutil.ts";
import { sandboxArgs, SYSTEMD_RUN } from "../sandbox.ts";
import { appLayout } from "./app.ts";
import { FILTER_OPS, type Filter, type Where } from "../sql-where.ts";
import { mongodbInstalled, readServices } from "./service.ts";

export const ENGINES = ["sqlite", "postgres", "mysql", "mongodb", "redis"] as const;
export type Engine = (typeof ENGINES)[number];
const OPS = ["tables", "rows", "query"] as const;
const NAMES: Record<Engine, string> = { sqlite: "SQLite", postgres: "Postgres", mysql: "MySQL", mongodb: "MongoDB", redis: "Redis" };

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) throw new ValidationError(field, `must be one of ${allowed.join(", ")}`);
  return value as T;
}

/**
 * The query, checked for its engine. SQL is one statement: a ";" before the
 * end could close the read-only transaction and start another. A MongoDB
 * filter is JSON (extended JSON for ObjectIds and dates) that runs no
 * JavaScript on the server. For Redis it's a key pattern, like session:*.
 */
export function assertQuery(engine: Engine, value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 20_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new ValidationError("query", "must be text of at most 20000 characters");
  }
  const query = value.trim();
  if (engine === "mongodb") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(query);
    } catch {
      throw new ValidationError("query", 'must be a JSON filter, like {"status": "active"}');
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ValidationError("query", 'must be a JSON filter, like {"status": "active"}');
    if (/"\$(where|function|accumulator)"/.test(query)) throw new ValidationError("query", "can't run JavaScript on the server ($where, $function, $accumulator)");
    return query;
  }
  if (engine === "redis") return assertLine(query, "query", 512);
  const statement = query.replace(/[;\s]+$/, "");
  if (statement.includes(";")) throw new ValidationError("query", "must be one statement, without ; (also inside quotes)");
  return statement;
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** A value typed into the builder or the editor: text, newlines allowed, no other control characters. */
export function assertValue(value: unknown, field: string, maxLength = 20_000): string {
  if (typeof value !== "string" || value.length > maxLength || CONTROL.test(value)) throw new ValidationError(field, `must be text of at most ${maxLength} characters`);
  return value;
}

/**
 * The visual builder's filters, for SQL tables: up to 20 of "column op
 * value", all or any of them. The job checks the columns exist and turns
 * values into parameters or quoted literals (sql-where.ts).
 */
export function assertWhere(value: unknown): Where | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new ValidationError("where", "must be {match, filters}");
  const w = value as Record<string, unknown>;
  const match = oneOf(w.match ?? "all", ["all", "any"] as const, "where.match");
  if (!Array.isArray(w.filters) || w.filters.length > 20) throw new ValidationError("where.filters", "must be a list of at most 20 filters");
  const filters = w.filters.map((raw, i): Filter => {
    const f = (raw ?? {}) as Record<string, unknown>;
    const at = `where.filters[${i}]`;
    const column = assertLine(f.column, `${at}.column`, 256);
    const op = oneOf(f.op, FILTER_OPS, `${at}.op`);
    if (op === "null" || op === "not_null") return { column, op };
    if (op === "in") {
      if (!Array.isArray(f.value) || !f.value.length || f.value.length > 100) throw new ValidationError(`${at}.value`, "must be a list of 1 to 100 values");
      return { column, op, value: f.value.map((v, j) => assertValue(v, `${at}.value[${j}]`, 2000)) };
    }
    return { column, op, value: assertValue(f.value, `${at}.value`, 2000) };
  });
  return filters.length ? { match, filters } : undefined;
}

async function dbBrowse(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const engine = oneOf(params.engine, ENGINES, "engine");
  const op = oneOf(params.op ?? "tables", OPS, "op");
  const app = appLayout(ctx, slug);
  if (!existsSync(app.etcDir)) throw new ActionError("not_found", `app ${slug} doesn't exist`);
  const state = readServices(ctx, slug);
  const has: Record<Engine, boolean> = { sqlite: true, postgres: !!state.postgres, mysql: !!state.mysql, mongodb: !!state.mongodb && mongodbInstalled(ctx), redis: !!state.redis };
  if (!has[engine]) throw new ActionError("not_found", `${slug} has no ${NAMES[engine]}`);

  const file = params.file === undefined || params.file === "" ? undefined : assertRelativePath(params.file, "file");
  if (engine === "sqlite" && file) {
    const stat = lstatSync(join(app.data, file), { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new ActionError("not_found", `${file} isn't a file in ${slug}'s data folder`);
  }
  if (engine === "sqlite" && op !== "tables" && !file) throw new ValidationError("file", "is required to look inside a SQLite database");
  // An empty data folder has no SQLite files: no job to look for them.
  if (engine === "sqlite" && !file && !(existsSync(app.data) && readdirSync(app.data).length > 0)) return { files: [], tables: [] };
  const table = params.table === undefined || params.table === "" ? undefined : assertLine(params.table, "table", 512);
  if (op === "rows" && !table) throw new ValidationError("table", "is required to show rows");
  if (op === "query" && engine === "mongodb" && !table) throw new ValidationError("table", "is required: a MongoDB filter runs on one collection");
  // Redis's key pattern also narrows the key list while a key is open.
  const query = params.query === undefined || params.query === "" ? undefined : assertQuery(engine, params.query);
  if (op === "query" && !query) throw new ValidationError("query", "is required to run a query");
  const where = assertWhere(params.where);
  if (where && (op !== "rows" || !(engine === "sqlite" || engine === "postgres" || engine === "mysql"))) throw new ValidationError("where", "only narrows a SQL table's rows");
  const request = {
    engine,
    op,
    file,
    table,
    query,
    offset: assertInt(params.offset ?? 0, "offset", 0, 10_000_000),
    limit: assertInt(params.limit ?? 50, "limit", 1, 200),
    sort: params.sort === undefined || params.sort === "" ? undefined : assertLine(params.sort, "sort", 256),
    desc: params.desc === true,
    where,
  };

  const user = await lookupUser(ctx.exec, app.user);
  if (!user) throw new ActionError("not_found", `user ${app.user} doesn't exist`);
  let output = "";
  const { code } = await ctx.spawn(
    SYSTEMD_RUN,
    sandboxArgs({
      unit: `layer-browse-${slug}-${randomBytes(3).toString("hex")}.service`,
      user: user.name,
      cwd: app.data,
      // SQLite touches a WAL database's -shm file even to read it.
      readWrite: engine === "sqlite" ? [app.data] : [],
      env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
      // DATABASE_URL, MONGODB_URI and REDIS_URL: the app's own logins.
      envFiles: engine === "sqlite" ? [] : [join(app.etcDir, "services.env")],
      memoryMb: 512,
      timeoutSec: 60,
      network: engine === "sqlite" ? false : "localhost",
      command: [ctx.paths.runtimeNode, "--no-warnings", "-e", BROWSE_JOB, JSON.stringify(request)],
    }),
    {
      onData: (chunk) => {
        if (output.length < 32 * 1024 * 1024) output += chunk;
      },
    },
  );
  const line = output.split("\n").find((l) => l.startsWith("LAYER-BROWSE "));
  if (code !== 0 || !line) {
    const reason = output.split("\n").filter((l) => l.startsWith("layer: ")).at(-1)?.slice(7);
    throw new ActionError("browse_failed", reason ?? `the viewer's job exited ${code}`);
  }
  return JSON.parse(line.slice("LAYER-BROWSE ".length)) as unknown;
}

export const browseActions: ActionTable = {
  "db.browse": { mutates: false, run: dbBrowse },
};

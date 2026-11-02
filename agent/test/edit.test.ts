import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appActions } from "../src/actions/app.ts";
import { assertWhere } from "../src/actions/browse.ts";
import { editActions } from "../src/actions/edit.ts";
import { BROWSE_JOB } from "../src/browse-job.ts";
import { NO_IO } from "../src/context.ts";
import { EDIT_JOB } from "../src/edit-job.ts";
import { WHERE_LIB } from "../src/sql-where.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

/** The builder's SQL for one dialect, from the same code the jobs run. */
function whereFor(dialect: "sqlite" | "postgres" | "mysql", where: unknown, columns: string[]) {
  const run = new Function("where", "columns", "dialect", `${WHERE_LIB}\nfunction fail(m) { throw new Error(m); }\nconst params = [];\nconst d = dialect === "sqlite" ? sqliteDialect(params) : dialect === "postgres" ? postgresDialect() : mysqlDialect();\nreturn { sql: whereSql(where, columns, d), params };`);
  return run(where, columns, dialect) as { sql: string; params: unknown[] };
}

describe("assertWhere", () => {
  it("takes up to 20 filters from a fixed list of operators", () => {
    expect(assertWhere(undefined)).toBeUndefined();
    expect(assertWhere({ match: "all", filters: [] })).toBeUndefined();
    expect(assertWhere({ filters: [{ column: "plan", op: "eq", value: "free" }] })).toEqual({ match: "all", filters: [{ column: "plan", op: "eq", value: "free" }] });
    expect(assertWhere({ match: "any", filters: [{ column: "email", op: "null", value: "ignored" }] })).toEqual({ match: "any", filters: [{ column: "email", op: "null" }] });
    expect(() => assertWhere({ filters: [{ column: "a", op: "regexp", value: "x" }] })).toThrow(/must be one of/);
    expect(() => assertWhere({ filters: [{ column: "a", op: "in", value: [] }] })).toThrow(/1 to 100/);
    expect(() => assertWhere({ filters: Array.from({ length: 21 }, () => ({ column: "a", op: "null" })) })).toThrow(/at most 20/);
    expect(() => assertWhere({ filters: [{ column: "a", op: "eq", value: 5 }] })).toThrow(/text/);
  });
});

describe("the builder's SQL", () => {
  const where = { match: "all", filters: [{ column: "email", op: "eq", value: "o'brien@x.com" }, { column: "name", op: "contains", value: "50%_\\" }] };

  it("binds SQLite values as parameters", () => {
    const { sql, params } = whereFor("sqlite", where, ["email", "name"]);
    expect(sql).toBe(` WHERE ("email" = ?) AND ("name" LIKE ? ESCAPE '\\')`);
    expect(params).toEqual(["o'brien@x.com", "%50\\%\\_\\\\%"]);
  });

  it("quotes Postgres and MySQL values as literals", () => {
    expect(whereFor("postgres", where, ["email", "name"]).sql).toBe(` WHERE ("email" = 'o''brien@x.com') AND ("name"::text ILIKE '%50\\%\\_\\\\%' ESCAPE '\\')`);
    expect(whereFor("mysql", where, ["email", "name"]).sql).toBe(" WHERE (`email` = 'o''brien@x.com') AND (`name` LIKE '%50\\\\%\\\\_\\\\\\\\%' ESCAPE '\\\\')");
  });

  it("quotes column names and refuses unknown ones", () => {
    expect(whereFor("postgres", { match: "any", filters: [{ column: 'a"b', op: "not_null" }, { column: "id", op: "in", value: ["1", "2"] }] }, ['a"b', "id"]).sql).toBe(` WHERE ("a""b" IS NOT NULL) OR ("id" IN ('1', '2'))`);
    expect(() => whereFor("sqlite", { match: "all", filters: [{ column: "nope", op: "null" }] }, ["id"])).toThrow(/no column nope/);
  });
});

describe("the jobs on a real SQLite database", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "layer-edit-"));
    const db = new DatabaseSync(join(dir, "app.db"));
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, plan TEXT, credits INTEGER);
      INSERT INTO users (email, plan, credits) VALUES ('a@x.com', 'free', 1), ('b@x.com', 'free', 2), ('c@x.com', 'pro', 3), ('o''brien@x.com', NULL, 4);
      CREATE TABLE log (msg TEXT);
      INSERT INTO log VALUES ('one'), ('two');
      CREATE VIEW pro AS SELECT * FROM users WHERE plan = 'pro';
    `);
    db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const job = (code: string, request: object) => {
    const r = spawnSync(process.execPath, ["--no-warnings", "-e", code, JSON.stringify(request)], { cwd: dir, encoding: "utf8" });
    const line = r.stdout.split("\n").find((l) => / \{/.test(l) && l.startsWith("LAYER-"));
    if (r.status !== 0 || !line) throw new Error(r.stderr.trim().replace(/^layer: /, ""));
    return JSON.parse(line.slice(line.indexOf(" ") + 1));
  };
  const browse = (request: object) => job(BROWSE_JOB, { engine: "sqlite", file: "app.db", op: "rows", offset: 0, limit: 50, ...request });
  const edit = (request: object) => job(EDIT_JOB, { engine: "sqlite", file: "app.db", table: "users", ...request });
  const rows = () => new DatabaseSync(join(dir, "app.db"), { readOnly: true }).prepare("SELECT id, email, plan, credits FROM users ORDER BY id").all();

  it("narrows rows with filters and returns their keys and columns", () => {
    const r = browse({ table: "users", where: { match: "all", filters: [{ column: "plan", op: "eq", value: "free" }] } }).result;
    expect(r.total).toBe(2);
    expect(r.rows).toEqual([[1, "a@x.com", "free", 1], [2, "b@x.com", "free", 2]]);
    expect(r.key).toEqual({ columns: ["id"], rows: [[1], [2]] });
    expect(r.editable).toBe(true);
    expect(r.schema).toContainEqual({ name: "email", type: "TEXT", nullable: false, pk: false });
    // A number typed as text still compares as a number in an INTEGER column.
    expect(browse({ table: "users", where: { match: "all", filters: [{ column: "credits", op: "gte", value: "3" }] } }).result.total).toBe(2);
    expect(browse({ table: "users", where: { match: "any", filters: [{ column: "plan", op: "null" }, { column: "email", op: "starts", value: "c@" }] } }).result.total).toBe(2);
  });

  it("finds rows of a table without a primary key by rowid, and never edits a view", () => {
    expect(browse({ table: "log" }).result.key).toEqual({ columns: ["rowid"], rows: [[1], [2]] });
    const view = browse({ table: "pro" }).result;
    expect(view.editable).toBe(false);
    expect(view.key).toBeNull();
    expect(() => edit({ table: "pro", mode: "count", target: { all: true } })).toThrow(/view/);
  });

  it("counts, then updates exactly the confirmed rows in one transaction", () => {
    const target = { where: { match: "all", filters: [{ column: "plan", op: "eq", value: "free" }] } };
    expect(edit({ mode: "count", target })).toEqual({ matches: 2 });
    expect(edit({ mode: "apply", target, set: [{ column: "plan", value: "pro" }, { column: "credits", value: "10" }], expect: 2 })).toEqual({ updated: 2 });
    expect(rows().slice(0, 2)).toEqual([
      { id: 1, email: "a@x.com", plan: "pro", credits: 10 },
      { id: 2, email: "b@x.com", plan: "pro", credits: 10 },
    ]);
  });

  it("updates rows picked by key, including NULL and quotes", () => {
    expect(edit({ mode: "apply", target: { keys: { columns: ["id"], rows: [[4]] } }, set: [{ column: "plan", value: null }, { column: "email", value: "x'); DROP TABLE users; --" }], expect: 1 })).toEqual({ updated: 1 });
    expect(rows()[3]).toEqual({ id: 4, email: "x'); DROP TABLE users; --", plan: null, credits: 4 });
    expect(edit({ table: "log", mode: "apply", target: { keys: { columns: ["rowid"], rows: [[2]] } }, set: [{ column: "msg", value: "TWO" }], expect: 1 })).toEqual({ updated: 1 });
  });

  it("writes nothing if the rows changed since the count", () => {
    const target = { where: { match: "all", filters: [{ column: "plan", op: "eq", value: "free" }] } };
    expect(() => edit({ mode: "apply", target, set: [{ column: "plan", value: "pro" }], expect: 3 })).toThrow(/2 rows match now, 3 when you checked\. Nothing was changed/);
    expect(rows().filter((r) => r.plan === "free")).toHaveLength(2);
  });

  it("refuses unknown columns and a stale primary key", () => {
    expect(() => edit({ mode: "apply", target: { all: true }, set: [{ column: "nope", value: "1" }], expect: 4 })).toThrow(/no column nope/);
    expect(() => edit({ mode: "count", target: { keys: { columns: ["email"], rows: [["a@x.com"]] } } })).toThrow(/primary key changed/);
  });
});

describe("db.count and db.update", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = testEnv();
    await appActions["app.create"]!.run({ slug: "piqo" }, env.ctx, NO_IO);
    writeFileSync(join(env.paths.appsRoot, "piqo", "data", "app.db"), "x");
  });
  afterEach(() => env.cleanup());
  const update = (params: object) => editActions["db.update"]!.run({ slug: "piqo", engine: "sqlite", file: "app.db", table: "users", ...params }, env.ctx, NO_IO);

  it("checks the request before any job starts", async () => {
    await expect(update({ engine: "mongodb", target: { all: true } })).rejects.toThrow(/must be one of sqlite, postgres, mysql/);
    await expect(update({ engine: "postgres", target: { all: true } })).rejects.toThrow(/has no Postgres/);
    await expect(update({ target: { all: true }, set: [{ column: "a", value: "1" }] })).rejects.toThrow(/expect/);
    await expect(update({ target: { all: true, where: {} }, set: [{ column: "a", value: "1" }], expect: 1 })).rejects.toThrow(/one of keys, where or all/);
    await expect(update({ target: { where: { filters: [] } }, set: [{ column: "a", value: "1" }], expect: 1 })).rejects.toThrow(/at least one filter/);
    await expect(update({ target: { all: true }, set: [], expect: 1 })).rejects.toThrow(/1 to 100 columns/);
    await expect(update({ target: { all: true }, set: [{ column: "a", value: "1" }, { column: "a", value: "2" }], expect: 1 })).rejects.toThrow(/twice/);
    await expect(update({ target: { keys: { columns: ["id"], rows: [[1, 2]] } }, set: [{ column: "a", value: "1" }], expect: 1 })).rejects.toThrow(/1 values/);
    await expect(update({ file: "../x.db", target: { all: true }, set: [{ column: "a", value: "1" }], expect: 1 })).rejects.toThrow(/'\.\.'/);
    expect(env.spawner.calls).toEqual([]);
  });

  it("runs one sandboxed job as the app's user and keeps values out of the audit log", async () => {
    env.spawner.respond = () => ({ code: 0, output: 'LAYER-EDIT {"updated":1}\n' });
    expect(await update({ target: { keys: { columns: ["id"], rows: [[1]] } }, set: [{ column: "password", value: "hunter2" }], expect: 1 })).toEqual({ updated: 1 });
    const call = env.spawner.calls[0]!;
    expect(call).toContain("--uid=app-piqo");
    expect(call).toContain("--property=IPAddressDeny=any");
    expect(JSON.parse(call.at(-1)!)).toMatchObject({ mode: "apply", expect: 1, set: [{ column: "password", value: "hunter2" }] });
    const audited = editActions["db.update"]!.redact!({ slug: "piqo", engine: "sqlite", table: "users", target: { keys: { columns: ["id"], rows: [[1]] } }, set: [{ column: "password", value: "hunter2" }], expect: 1 });
    expect(JSON.stringify(audited)).not.toContain("hunter2");
    expect(audited).toMatchObject({ table: "users", columns: ["password"], rows: 1 });
  });

  it("says why when the job fails", async () => {
    env.spawner.respond = () => ({ code: 2, output: "layer: 2 rows match now, 3 when you checked. Nothing was changed: look again and retry.\n" });
    await expect(update({ target: { all: true }, set: [{ column: "a", value: "1" }], expect: 3 })).rejects.toThrow(/Nothing was changed/);
  });
});

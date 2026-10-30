import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appActions } from "../src/actions/app.ts";
import { assertQuery, browseActions } from "../src/actions/browse.ts";
import { NO_IO } from "../src/context.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

describe("assertQuery", () => {
  it("takes one SQL statement, with a trailing ; or without", () => {
    expect(assertQuery("postgres", "  SELECT * FROM t;  ")).toBe("SELECT * FROM t");
    expect(assertQuery("sqlite", "SELECT 1 -- note\n")).toBe("SELECT 1 -- note");
    expect(() => assertQuery("mysql", "SELECT 1; DROP TABLE t")).toThrow(/one statement/);
    // A ; could close the read-only transaction and start another: never let one through.
    expect(() => assertQuery("postgres", "SELECT 1) q; COMMIT; DROP TABLE t; SELECT (1")).toThrow(/one statement/);
    expect(() => assertQuery("postgres", "  ")).toThrow(/at most 20000/);
    expect(() => assertQuery("sqlite", "SELECT '\u0000'")).toThrow(/at most 20000/);
  });

  it("takes a MongoDB filter as JSON that runs no JavaScript", () => {
    expect(assertQuery("mongodb", '{"status": "active"}')).toBe('{"status": "active"}');
    expect(assertQuery("mongodb", '{"_id": {"$oid": "65f0c0ffee0000000000abcd"}}')).toContain("$oid");
    expect(() => assertQuery("mongodb", "{status: 'active'}")).toThrow(/JSON filter/);
    expect(() => assertQuery("mongodb", "[1]")).toThrow(/JSON filter/);
    expect(() => assertQuery("mongodb", '{"$where": "sleep(10000) || true"}')).toThrow(/JavaScript/);
    expect(() => assertQuery("mongodb", '{"a": {"$function": {}}}')).toThrow(/JavaScript/);
  });

  it("takes a Redis key pattern on one line", () => {
    expect(assertQuery("redis", "session:*")).toBe("session:*");
    expect(() => assertQuery("redis", "a\nb")).toThrow(/single line/);
  });
});

describe("db.browse", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = testEnv();
    await appActions["app.create"]!.run({ slug: "piqo" }, env.ctx, NO_IO);
  });
  afterEach(() => env.cleanup());
  const browse = (params: object) => browseActions["db.browse"]!.run({ slug: "piqo", ...params }, env.ctx, NO_IO);
  const data = () => join(env.paths.appsRoot, "piqo", "data");

  it("only opens databases the app has", async () => {
    await expect(browse({ engine: "postgres" })).rejects.toThrow(/has no Postgres/);
    await expect(browse({ engine: "redis" })).rejects.toThrow(/has no Redis/);
    await expect(browse({ engine: "oracle" })).rejects.toThrow(/must be one of/);
    await expect(browseActions["db.browse"]!.run({ slug: "nope", engine: "sqlite" }, env.ctx, NO_IO)).rejects.toThrow(/doesn't exist/);
  });

  it("checks the request before any job starts", async () => {
    await expect(browse({ engine: "sqlite", file: "app.db" })).rejects.toThrow(/isn't a file/);
    writeFileSync(join(data(), "app.db"), "x");
    await expect(browse({ engine: "sqlite", op: "rows", file: "app.db" })).rejects.toThrow(/table/);
    await expect(browse({ engine: "sqlite", op: "rows", table: "t" })).rejects.toThrow(/file/);
    await expect(browse({ engine: "sqlite", file: "../piqo.db" })).rejects.toThrow(/'\.\.'/);
    symlinkSync("/etc/passwd", join(data(), "link.db"));
    await expect(browse({ engine: "sqlite", file: "link.db" })).rejects.toThrow(/isn't a file/);
    await expect(browse({ engine: "sqlite", op: "query", file: "app.db", query: "SELECT 1; DELETE FROM t" })).rejects.toThrow(/one statement/);
    await expect(browse({ engine: "sqlite", op: "rows", file: "app.db", table: "t", limit: 500 })).rejects.toThrow(/limit/);
    expect(env.spawner.calls).toEqual([]);
  });

  it("runs one sandboxed job as the app's user, with the app's logins only for a database server", async () => {
    writeFileSync(join(data(), "app.db"), "x");
    env.spawner.respond = () => ({ code: 0, output: 'LAYER-BROWSE {"tables":[{"name":"licenses","type":"table","rows":3}]}\n' });
    expect(await browse({ engine: "sqlite", file: "app.db" })).toEqual({ tables: [{ name: "licenses", type: "table", rows: 3 }] });
    const sqlite = env.spawner.calls[0]!;
    expect(sqlite).toContain("--uid=app-piqo");
    expect(sqlite).toContain(`--property=ReadWritePaths=${data()}`);
    expect(sqlite).toContain("--property=IPAddressDeny=any");
    expect(sqlite.join(" ")).not.toContain("services.env");
    // The request is the job's last argument, never through a shell.
    expect(JSON.parse(sqlite.at(-1)!)).toMatchObject({ engine: "sqlite", op: "tables", file: "app.db", offset: 0, limit: 50 });

    writeFileSync(join(env.paths.appEtcRoot, "piqo", "services.json"), JSON.stringify({ postgres: { database: "app_piqo", user: "app_piqo", password: "x" } }));
    await browse({ engine: "postgres", op: "query", query: 'SELECT "$1"' });
    const pg = env.spawner.calls[1]!;
    expect(pg).toContain(`--property=EnvironmentFile=-${join(env.paths.appEtcRoot, "piqo", "services.env")}`);
    expect(pg).toContain("--property=IPAddressAllow=localhost");
    expect(pg).toContain("--property=ReadWritePaths=");
    // systemd would read ${...} in a command as a variable: $ goes as $$.
    expect(pg.at(-1)).toContain('SELECT \\"$$1\\"');
  });

  it("says why when the job fails", async () => {
    writeFileSync(join(data(), "app.db"), "x");
    env.spawner.respond = () => ({ code: 2, output: "layer: attempt to write a readonly database\n" });
    await expect(browse({ engine: "sqlite", op: "query", file: "app.db", query: "DELETE FROM t" })).rejects.toThrow(/readonly database/);
  });
});

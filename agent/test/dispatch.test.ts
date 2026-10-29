import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSlug } from "@layer/protocol";
import { Audit } from "../src/audit.ts";
import type { ActionTable } from "../src/context.ts";
import { createDispatcher, type Dispatcher } from "../src/dispatch.ts";
import { ActionError } from "../src/errors.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
let dispatcher: Dispatcher;
const order: string[] = [];

const table: ActionTable = {
  "system.info": { mutates: false, run: async () => ({ hello: "world" }) },
  "app.create": {
    mutates: true,
    run: async (p) => {
      const slug = assertSlug(p.slug);
      order.push(`start ${slug}`);
      await new Promise((r) => setTimeout(r, slug === "slow" ? 30 : 1));
      order.push(`end ${slug}`);
      return { slug };
    },
  },
  "app.delete": {
    mutates: true,
    run: async () => {
      throw new ActionError("not_found", "app nope doesn't exist");
    },
  },
  "unit.start": {
    mutates: true,
    run: async () => {
      throw new Error("useradd: secret stderr /etc/shadow");
    },
  },
  "env.write": {
    mutates: true,
    run: async () => ({ ok: true }),
    redact: (p) => ({ slug: p.slug, keys: Object.keys(p.vars as object) }),
  },
  "release.point": {
    mutates: true,
    lock: "build",
    run: async (p) => {
      order.push(`start build ${p.slug}`);
      await new Promise((r) => setTimeout(r, 40));
      order.push(`end build ${p.slug}`);
      return {};
    },
  },
};

const call = async (req: unknown) => dispatcher.handleLine(typeof req === "string" ? req : JSON.stringify(req));

beforeEach(() => {
  env = testEnv();
  order.length = 0;
  dispatcher = createDispatcher(env.ctx, new Audit(env.paths.auditLog), table);
});
afterEach(() => env.cleanup());

describe("request validation", () => {
  it("rejects malformed requests without an id", async () => {
    expect(await call("{not json")).toMatchObject({ id: null, error: { code: "bad_request" } });
    expect(await call("[1,2]")).toMatchObject({ id: null, error: { code: "bad_request" } });
    expect(await call({ action: "system.info" })).toMatchObject({ id: null, error: { code: "bad_request" } });
    expect(await call({ id: "a b", action: "system.info" })).toMatchObject({ error: { code: "bad_request" } });
    expect(await call({ id: "x".repeat(65), action: "system.info" })).toMatchObject({ error: { code: "bad_request" } });
  });

  it("rejects actions outside the allowlist", async () => {
    for (const action of ["shell.exec", "__proto__", "constructor", "toString", 42, null]) {
      expect(await call({ id: "1", action })).toMatchObject({ id: "1", ok: false, error: { code: "unknown_action" } });
    }
  });

  it("reports allowlisted actions that have no handler yet", async () => {
    expect(await call({ id: "1", action: "proxy.set" })).toMatchObject({ error: { code: "not_implemented" } });
  });

  it("requires params to be an object", async () => {
    for (const params of [[], "x", 1, null]) {
      expect(await call({ id: "1", action: "app.create", params })).toMatchObject({ error: { code: "invalid_params" } });
    }
  });
});

describe("results and errors", () => {
  it("returns results", async () => {
    expect(await call({ id: "r1", action: "system.info" })).toEqual({ id: "r1", ok: true, result: { hello: "world" } });
  });

  it("maps validation errors to invalid_params", async () => {
    const res = await call({ id: "1", action: "app.create", params: { slug: "../etc" } });
    expect(res).toMatchObject({ ok: false, error: { code: "invalid_params" } });
    expect(JSON.stringify(res)).toContain("slug");
  });

  it("passes ActionError codes through", async () => {
    expect(await call({ id: "1", action: "app.delete", params: {} })).toMatchObject({
      error: { code: "not_found", message: "app nope doesn't exist" },
    });
  });

  it("hides unexpected error details from the caller", async () => {
    const original = console.error;
    console.error = () => {};
    const res = await call({ id: "1", action: "unit.start", params: {} });
    console.error = original;
    expect(res).toMatchObject({ error: { code: "internal" } });
    expect(JSON.stringify(res)).not.toContain("shadow");
  });
});

describe("audit log", () => {
  it("records start and end of every call, with redacted params", async () => {
    await call({ id: "e1", action: "env.write", params: { slug: "piqo", vars: { DB_PASSWORD: "hunter2" } } });
    await call({ id: "e2", action: "app.delete", params: {} });
    const log = readFileSync(env.paths.auditLog, "utf8");
    expect(log).not.toContain("hunter2");
    const entries = log.trim().split("\n").map((l) => JSON.parse(l));
    expect(entries.map((e) => [e.id, e.phase, e.ok ?? null])).toEqual([
      ["e1", "start", null],
      ["e1", "end", true],
      ["e2", "start", null],
      ["e2", "end", false],
    ]);
    expect(entries[0].params).toEqual({ slug: "piqo", keys: ["DB_PASSWORD"] });
    expect(entries[3].code).toBe("not_found");
  });

  it("leaves out status reads, and rotates past its size limit", async () => {
    await call({ id: "r1", action: "system.info", params: {} });
    expect(existsSync(env.paths.auditLog)).toBe(false);
    const audit = new Audit(env.paths.auditLog, 200);
    for (let i = 0; i < 5; i++) audit.write({ id: `x${i}`, action: "app.create", phase: "start", params: { slug: "a".repeat(40) } });
    expect(existsSync(`${env.paths.auditLog}.1`)).toBe(true);
    expect(readFileSync(env.paths.auditLog, "utf8").trim().split("\n").length).toBeLessThan(5);
  });
});

describe("locking", () => {
  it("runs mutating actions one at a time", async () => {
    await Promise.all([
      call({ id: "1", action: "app.create", params: { slug: "slow" } }),
      call({ id: "2", action: "app.create", params: { slug: "fast" } }),
    ]);
    expect(order).toEqual(["start slow", "end slow", "start fast", "end fast"]);
  });

  it("doesn't let a build hold up global actions", async () => {
    await Promise.all([
      call({ id: "1", action: "release.point", params: { slug: "big" } }),
      call({ id: "2", action: "app.create", params: { slug: "fast" } }),
    ]);
    expect(order).toEqual(["start build big", "start fast", "end fast", "end build big"]);
  });

  it("runs builds one at a time", async () => {
    await Promise.all([
      call({ id: "1", action: "release.point", params: { slug: "one" } }),
      call({ id: "2", action: "release.point", params: { slug: "two" } }),
    ]);
    expect(order).toEqual(["start build one", "end build one", "start build two", "end build two"]);
  });

  it("keeps going after a failed mutating action", async () => {
    await call({ id: "1", action: "app.delete", params: {} });
    expect(await call({ id: "2", action: "app.create", params: { slug: "next" } })).toMatchObject({ ok: true });
  });
});

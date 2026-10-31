import { describe, expect, it } from "vitest";
import { importCsv, parseCsv, toCsv } from "../src/csv.ts";
import { checkSlug, checkTags, checkTarget } from "../src/validate.ts";
import { openDb } from "../src/db.ts";
import { Store } from "../src/store.ts";
import { DEFAULT_SETTINGS } from "./helpers.ts";

describe("what a link may be", () => {
  it("lowercases slugs, and refuses odd ones and reserved words", () => {
    expect(checkSlug(" Launch-2026 ")).toBe("launch-2026");
    for (const bad of ["", "-x", "a b", "a/b", "x".repeat(65), "API", "healthz", "_admin", "ünï"]) expect(() => checkSlug(bad), bad).toThrow();
  });

  it("only takes http(s) targets on public addresses", () => {
    expect(checkTarget("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    for (const bad of ["ftp://example.com", "javascript:alert(1)", "https://localhost/x", "http://app.localhost", "http://127.0.0.1", "http://10.0.0.5", "http://192.168.1.1", "http://172.20.0.1", "http://169.254.169.254/latest", "http://[::1]/", "http://[fd00::1]", "https://user:pw@example.com", "not a url", "https://a.com/\nb"]) {
      expect(() => checkTarget(bad), bad).toThrow();
    }
  });

  it("reads tags from a list or comma-separated text", () => {
    expect(checkTags("launch, x ,launch")).toEqual(["launch", "x"]);
    expect(() => checkTags(Array.from({ length: 11 }, (_, i) => `t${i}`))).toThrow(/at most 10/);
    expect(() => checkTags(["<b>"])).toThrow(/isn't a tag/);
  });
});

describe("CSV", () => {
  it("reads quoted cells and other shorteners' columns, and skips what can't be a link", () => {
    expect(parseCsv('a,b\n"x, ""y""",2\r\n"multi\nline",3\n')).toEqual([["a", "b"], ['x, "y"', "2"], ["multi\nline", "3"]]);
    const db = openDb(":memory:");
    const store = new Store(db, () => DEFAULT_SETTINGS);
    const r = importCsv(store, "Long URL,Back-half,Title,Tags\nhttps://a.example/1,first,One,x|y\nhttp://localhost/2,second,,\nhttps://b.example/2,first,,\nhttps://c.example/3,,Three,\n");
    expect(r.created).toBe(2);
    expect(r.skipped).toEqual([
      { line: 3, reason: "target: can't point at this server (localhost)" },
      { line: 4, reason: "slug: first is taken" },
    ]);
    expect(store.bySlug("FIRST")).toMatchObject({ target: "https://a.example/1", title: "One", tags: ["x", "y"] });
    const again = parseCsv(toCsv(store.list().links));
    expect(again[0]).toContain("target");
    expect(again).toHaveLength(3);
  });
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A layout's check doesn't protect its pages: on client-side navigation Next.js renders only the page
// (the request names the layouts it already has, and anyone can send that request). So every page
// checks the session itself, first.
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f === "page.tsx" ? [join(d, f)] : []));

describe("the panel's pages", () => {
  it("each check the session before anything else", () => {
    const pages = walk(join(__dirname, "..", "app", "(app)"));
    expect(pages.length).toBeGreaterThan(50);
    const unchecked = pages.filter((f) => {
      const s = readFileSync(f, "utf8");
      const m = /export default async function \w*\s*\(/.exec(s);
      if (!m) return true;
      let i = m.index + m[0].length;
      for (let depth = 1; depth > 0; i++) depth += s[i] === "(" ? 1 : s[i] === ")" ? -1 : 0;
      const first = s.slice(s.indexOf("{", i) + 1).split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("//")) ?? "";
      return !/^(const \w+ = )?await requireUser\(\);$/.test(first);
    });
    expect(unchecked).toEqual([]);
  });
});

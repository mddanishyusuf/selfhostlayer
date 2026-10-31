import { describe, expect, it } from "vitest";
import { projectMarks } from "./avatar";

const SLUGS = ["next", "vite", "piqo", "maillayer", "picker", "blogcms", "shl", "reduce-png-size", "superdevpro", "postscheduler"];

describe("projectMarks", () => {
  it("gives every project a mark of its own, the same one every time", () => {
    const marks = projectMarks(SLUGS);
    expect(new Set(marks.values()).size).toBe(SLUGS.length);
    expect([...marks.values()].every((m) => m.startsWith("data:image/svg+xml;utf8,%3Csvg"))).toBe(true);
    expect(projectMarks(SLUGS)).toEqual(marks);
  });

  it("never changes an older project's mark when one is added", () => {
    const before = projectMarks(SLUGS);
    const after = projectMarks([...SLUGS, "landing", "api", "docs"]);
    for (const slug of SLUGS) expect(after.get(slug)).toBe(before.get(slug));
  });
});

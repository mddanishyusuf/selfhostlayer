import { describe, expect, it } from "vitest";
import { pageOf, type PickerRepo } from "./github-repos";

const repo = (fullName: string, day: number): PickerRepo => ({ fullName, private: false, pushedAt: `2026-10-${String(day).padStart(2, "0")}T00:00:00Z`, branch: "main", installationId: 1 });
// As allRepos keeps them: most recently pushed first.
const all = Array.from({ length: 25 }, (_, i) => repo(i % 5 === 0 ? `acme/site-${i}` : `me/app-${i}`, 28 - i));

describe("pageOf", () => {
  it("pages through the list ten at a time, newest first", () => {
    const first = pageOf(all, "", 0, 10);
    expect(first.repos.map((r) => r.fullName)).toEqual(all.slice(0, 10).map((r) => r.fullName));
    expect(first).toMatchObject({ total: 25, matches: 25, next: 10 });
    expect(pageOf(all, "", 10, 10).next).toBe(20);
    expect(pageOf(all, "", 20, 10)).toMatchObject({ next: null });
    expect(pageOf(all, "", 20, 10).repos).toHaveLength(5);
  });

  it("searches every repository by owner or name, ignoring case and spaces around", () => {
    const found = pageOf(all, "  ACME/Site ", 0, 10);
    expect(found.repos.map((r) => r.fullName)).toEqual(["acme/site-0", "acme/site-5", "acme/site-10", "acme/site-15", "acme/site-20"]);
    expect(found).toMatchObject({ total: 25, matches: 5, next: null });
    expect(pageOf(all, "nothing-like-this", 0, 10)).toMatchObject({ repos: [], matches: 0, next: null });
  });
});

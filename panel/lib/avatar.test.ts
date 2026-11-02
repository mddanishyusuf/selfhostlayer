import { describe, expect, it } from "vitest";
import { iconsFor, pickMarks, projectMarks } from "./avatar";

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

  it("picks the icon from what the name says", () => {
    const icon = (slug: string) => iconsFor(slug)[0];
    expect(icon("reduce-png-size")).toBe("camera");
    expect(icon("superdevdocs")).toBe("book");
    expect(icon("payonceuseforever")).toBe("cashCoin");
    expect(icon("post-schedulers")).toBe("clock");
    expect(icon("trafficsource-website")).toBe("signpostSplit");
    expect(icon("diskbuddy-landing")).toBe("hdd");
    expect(icon("onemacapp-website")).toBe("laptop");
    expect(icon("uptime-monitor")).toBe("stoplights");
    // Short words only match whole parts, or the ends of long ones.
    expect(icon("picker")).toBe("palette");
    expect(icon("keyboard-shortcuts")).not.toBe("paperclip");
  });

  it("gives projects about the same thing different icons, then different colors", () => {
    const picks = pickMarks(["design-tools", "picker-design-website", "rowie-website", "mohddanish-com", "my-site", "site-two", "site-three", "site-four"]);
    expect(picks.get("design-tools")!.icon).toBe("palette");
    expect(picks.get("picker-design-website")!.icon).toBe("palette2");
    expect(["rowie-website", "mohddanish-com", "my-site"].map((s) => picks.get(s)!.icon)).toEqual(["globe", "globe2", "display"]);
    // Out of website icons: globe again, in a color no other globe has.
    const globes = [...picks.values()].filter((p) => p.icon === "globe").map((p) => p.color);
    expect(globes.length).toBeGreaterThan(1);
    expect(new Set(globes).size).toBe(globes.length);
  });

  it("gives names that say nothing an icon each, not all the same one", () => {
    const picks = pickMarks(["shl", "superdevpro", "kiwi", "zeta"]);
    expect(new Set([...picks.values()].map((p) => p.icon)).size).toBe(4);
  });
});

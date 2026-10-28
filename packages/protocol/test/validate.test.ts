import { describe, expect, it } from "vitest";
import {
  assertColor,
  assertCommand,
  assertFullSha,
  assertGithubOwner,
  assertGithubRepo,
  assertPackageManager,
  assertDomain,
  assertHealthPath,
  assertEnvKey,
  assertInt,
  assertLine,
  assertNodeVersion,
  assertRelativePath,
  assertSha,
  assertSlug,
  isActionName,
} from "../src/index.ts";

describe("assertSlug", () => {
  it.each(["ab", "piqo", "maillayer-lite", "a1", "x".repeat(31)])("accepts %s", (slug) => {
    expect(assertSlug(slug)).toBe(slug);
  });

  it.each([
    "",
    "a",
    "1app",
    "-app",
    "app-",
    "my--app",
    "App",
    "my_app",
    "my.app",
    "../etc",
    "a/b",
    "app\n",
    "x".repeat(32),
    42,
    null,
  ])("rejects %j", (slug) => {
    expect(() => assertSlug(slug)).toThrow(/slug/);
  });
});

describe("assertColor", () => {
  it("accepts blue and green only", () => {
    expect(assertColor("blue")).toBe("blue");
    expect(assertColor("green")).toBe("green");
    expect(() => assertColor("red")).toThrow();
    expect(() => assertColor("blue ")).toThrow();
  });
});

describe("assertNodeVersion", () => {
  it("accepts exact versions only", () => {
    expect(assertNodeVersion("24.11.0")).toBe("24.11.0");
    for (const bad of ["24", "24.11", "v24.11.0", "24.11.0-rc1", "24.11.0/../x", "latest"]) {
      expect(() => assertNodeVersion(bad)).toThrow();
    }
  });
});

describe("assertSha", () => {
  it("accepts short and full lowercase hex", () => {
    expect(assertSha("abc1234")).toBe("abc1234");
    expect(assertSha("a".repeat(40))).toBe("a".repeat(40));
    for (const bad of ["abc123", "ABC1234", "a".repeat(41), "abc1234/..", "g123456"]) {
      expect(() => assertSha(bad)).toThrow();
    }
  });
});

describe("assertInt", () => {
  it("enforces integer bounds", () => {
    expect(assertInt(512, "memoryMaxMb", 64, 16384)).toBe(512);
    for (const bad of [63, 16385, 1.5, "512", Number.NaN]) {
      expect(() => assertInt(bad, "memoryMaxMb", 64, 16384)).toThrow(/memoryMaxMb/);
    }
  });
});

describe("assertEnvKey", () => {
  it("accepts conventional env names", () => {
    for (const key of ["PORT", "DATABASE_URL", "_X", "NEXT_PUBLIC_A1"]) {
      expect(assertEnvKey(key)).toBe(key);
    }
    for (const bad of ["port", "1X", "A-B", "A B", "A=B", ""]) {
      expect(() => assertEnvKey(bad)).toThrow();
    }
  });
});

describe("assertLine", () => {
  it("rejects newlines and control characters", () => {
    expect(assertLine("postgres://u:p@localhost/db?x=1 y", "v")).toContain("postgres");
    for (const bad of ["a\nb", "a\rb", "a\u0000b", "a\tb", "a\u007fb"]) {
      expect(() => assertLine(bad, "v")).toThrow();
    }
    expect(() => assertLine("x".repeat(11), "v", 10)).toThrow();
  });
});

describe("assertRelativePath", () => {
  it("accepts nested relative paths", () => {
    expect(assertRelativePath(".next/cache")).toBe(".next/cache");
    expect(assertRelativePath("public/uploads")).toBe("public/uploads");
  });

  it.each(["", "/etc", "../x", "a/../b", "a//b", "a/./b", "a/", "a b", "a\nb"])(
    "rejects %j",
    (path) => {
      expect(() => assertRelativePath(path)).toThrow();
    },
  );
});

describe("isActionName", () => {
  it("only knows allowlisted actions", () => {
    expect(isActionName("unit.start")).toBe(true);
    expect(isActionName("shell.exec")).toBe(false);
    expect(isActionName("__proto__")).toBe(false);
  });
});

describe("assertDomain", () => {
  it.each(["example.com", "app.example.com", "hello.internal", "xn--bcher-kva.example", "a-b.co", "1.example.com"])(
    "accepts %s",
    (d) => expect(assertDomain(d)).toBe(d),
  );
  it.each(["localhost", "Example.com", "*.example.com", "-a.com", "a-.com", "a..com", "1.2.3.4", "a.com.", "a b.com", "a.com/x", "a".repeat(64) + ".com"])(
    "rejects %j",
    (d) => expect(() => assertDomain(d)).toThrow(/domain/),
  );
});

describe("assertHealthPath", () => {
  it("accepts simple paths only", () => {
    expect(assertHealthPath("/")).toBe("/");
    expect(assertHealthPath("/api/health?full=1")).toBe("/api/health?full=1");
    for (const bad of ["", "health", "/a b", "/a\nb", "//evil.com\r\n", "/" + "x".repeat(256)]) {
      expect(() => assertHealthPath(bad)).toThrow();
    }
  });
});

describe("GitHub source validators", () => {
  it("accepts real owner/repo names and full shas only", () => {
    expect(assertGithubOwner("mddanishyusuf")).toBe("mddanishyusuf");
    expect(assertGithubRepo("selfhostlayer-examples")).toBe("selfhostlayer-examples");
    expect(assertGithubRepo("next.js")).toBe("next.js");
    expect(assertFullSha("a".repeat(40))).toBe("a".repeat(40));
    for (const bad of ["-x", "a/b", "a b", "x".repeat(40), "../x", ""]) expect(() => assertGithubOwner(bad)).toThrow();
    for (const bad of [".", "..", "a/b", "a b", "x".repeat(101), "a?b"]) expect(() => assertGithubRepo(bad)).toThrow();
    for (const bad of ["abc1234", "A".repeat(40), "a".repeat(41), "main"]) expect(() => assertFullSha(bad)).toThrow();
  });

  it("knows the four package managers", () => {
    expect(assertPackageManager("pnpm")).toBe("pnpm");
    expect(() => assertPackageManager("deno")).toThrow(/packageManager/);
  });

  it("accepts one-line commands", () => {
    expect(assertCommand("  yarn build && node scripts/x.js ", "buildCommand")).toBe("yarn build && node scripts/x.js");
    expect(() => assertCommand("a\nb", "buildCommand")).toThrow();
    expect(() => assertCommand("   ", "buildCommand")).toThrow(/empty/);
  });
});

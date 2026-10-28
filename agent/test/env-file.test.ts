import { describe, expect, it } from "vitest";
import { assertEnvVars, parseColorEnvPort, renderColorEnv, renderEnvFile } from "../src/templates/env-file.ts";

describe("renderEnvFile", () => {
  it("double-quotes values and escapes only backslash and double quote", () => {
    // Expected output matches what systemd 255 reads back unchanged (tested in a VM).
    expect(
      renderEnvFile({
        PLAIN: "hello world",
        DOLLAR: "cost $5 and ${HOME}",
        QUOTE: 'say "hi"',
        BACKSLASH: "a\\b\\nc",
        HASH: "a#b # not a comment",
        SPACES: "  both  ",
        EMPTY: "",
      }),
    ).toBe(
      [
        "# Managed by layer-agent. Edit env vars in the panel.",
        'PLAIN="hello world"',
        'DOLLAR="cost $5 and ${HOME}"',
        'QUOTE="say \\"hi\\""',
        'BACKSLASH="a\\\\b\\\\nc"',
        'HASH="a#b # not a comment"',
        'SPACES="  both  "',
        'EMPTY=""',
        "",
      ].join("\n"),
    );
  });
});

describe("assertEnvVars", () => {
  it("accepts a plain object of valid vars", () => {
    expect(assertEnvVars({ DATABASE_URL: "postgres://x", EMPTY: "" })).toEqual({ DATABASE_URL: "postgres://x", EMPTY: "" });
  });

  it("rejects anything that could add lines to the file", () => {
    expect(() => assertEnvVars({ A: "x\nPORT=1" })).toThrow(/vars\.A/);
    expect(() => assertEnvVars({ "A\nB": "x" })).toThrow();
    expect(() => assertEnvVars({ "A=B": "x" })).toThrow();
  });

  it("rejects bad shapes and sizes", () => {
    for (const bad of [null, [], "A=1", 1]) expect(() => assertEnvVars(bad)).toThrow(/vars/);
    expect(() => assertEnvVars({ lower: "x" })).toThrow();
    expect(() => assertEnvVars({ A: 1 })).toThrow();
    expect(() => assertEnvVars({ A: "x".repeat(32 * 1024 + 1) })).toThrow();
    const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`V${i}`, "x"]));
    expect(() => assertEnvVars(many)).toThrow(/at most/);
  });
});

describe("color env", () => {
  it("round-trips the port", () => {
    const file = renderColorEnv(4001);
    expect(file).toContain("PORT=4001\nHOSTNAME=127.0.0.1\nHOST=127.0.0.1\nNODE_ENV=production\n");
    expect(parseColorEnvPort(file)).toBe(4001);
    expect(parseColorEnvPort("NOPE=1")).toBeNull();
    expect(() => renderColorEnv(80)).toThrow();
  });
});

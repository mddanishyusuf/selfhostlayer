import { describe, expect, it } from "vitest";
import { parseDotEnv, parseEnvVars, parseSettings, parseStartCommand } from "./project-settings";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const node = { branch: "main", runtime: "node", startCommand: "node server.js", healthPath: "/health", nodeVersion: "24.13.1", memoryMb: "512", env: "{}" };

describe("parseSettings", () => {
  it("reads a Node project", () => {
    const r = parseSettings(form({ ...node, buildCommand: " npm run build ", writablePaths: ".next/cache, uploads" }));
    expect(r).toEqual({
      ok: true,
      value: {
        branch: "main",
        installCommand: null,
        buildCommand: "npm run build",
        runtime: { kind: "node", exec: ["node", "server.js"], writablePaths: [".next/cache", "uploads"], healthPath: "/health" },
        nodeVersion: "24.13.1",
        memoryMb: 512,
        env: {},
      },
    });
  });

  it("reads a static project", () => {
    const r = parseSettings(form({ branch: "main", runtime: "static", outputDir: "dist", spa: "on", nodeVersion: "24.13.1", memoryMb: "512", env: '{"API_URL":"https://x"}' }));
    expect(r.ok && r.value.runtime).toEqual({ kind: "static", outputDir: "dist", spa: true });
    expect(r.ok && r.value.env).toEqual({ API_URL: "https://x" });
  });

  it("reports every bad field at once", () => {
    const r = parseSettings(form({ branch: "../x", runtime: "node", startCommand: "bash -c id", healthPath: "health", nodeVersion: "24", memoryMb: "64", buildCommand: "a\nb", env: '{"bad-key":"x"}' }));
    expect(r.ok).toBe(false);
    expect(Object.keys(!r.ok ? r.errors : {}).sort()).toEqual(["branch", "buildCommand", "env", "healthPath", "memoryMb", "nodeVersion", "startCommand"]);
  });

  it("refuses multi-line env values and paths outside the project", () => {
    expect(parseSettings(form({ ...node, env: '{"A":"x\\ny"}' }))).toMatchObject({ ok: false, errors: { env: expect.stringContaining("single line") } });
    expect(parseSettings(form({ ...node, runtime: "static", outputDir: "../../etc" }))).toMatchObject({ ok: false, errors: { outputDir: expect.any(String) } });
  });

  it("leaves env out when the form has no env editor, so saving keeps the variables", () => {
    const { env: _env, ...withoutEnv } = node;
    const r = parseSettings(form(withoutEnv));
    expect(r.ok && "env" in r.value).toBe(false);
  });
});

describe("parseEnvVars", () => {
  it("reads the editor's JSON and checks names", () => {
    expect(parseEnvVars('{"API_KEY":"x"}')).toEqual({ ok: true, env: { API_KEY: "x" } });
    expect(parseEnvVars('{"api-key":"x"}')).toMatchObject({ ok: false, error: expect.stringContaining("isn't a valid name") });
    expect(parseEnvVars("[1]")).toMatchObject({ ok: false });
  });
});

describe("parseStartCommand", () => {
  it("splits into argv and requires node, npm or npx", () => {
    expect(parseStartCommand("node  dist/main.js --x")).toEqual(["node", "dist/main.js", "--x"]);
    expect(parseStartCommand("npm start")).toEqual(["npm", "start"]);
    expect(typeof parseStartCommand("yarn start")).toBe("string");
    expect(typeof parseStartCommand("")).toBe("string");
  });
});

describe("parseDotEnv", () => {
  it("handles comments, export, quotes and inline comments", () => {
    expect(
      parseDotEnv(`# comment
export DATABASE_URL="postgres://u:p@h/db"
API_KEY='abc def'
PLAIN=value # trailing comment
HASH="a#b"
EMPTY=
not a line
lower_case=ok`),
    ).toEqual({ DATABASE_URL: "postgres://u:p@h/db", API_KEY: "abc def", PLAIN: "value", HASH: "a#b", EMPTY: "", lower_case: "ok" });
  });
});

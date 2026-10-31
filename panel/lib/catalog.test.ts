import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppManifest } from "@layer/protocol";
import { describe, expect, it } from "vitest";

// db() opens LAYER_DB when first used: a fresh database for this file. The
// fake agent's catalog lists the hello app (lib/agent.ts).
process.env.LAYER_DB = join(mkdtempSync(join(tmpdir(), "layer-catalog-")), "panel.db");
process.env.LAYER_FAKE_AGENT = "1";
process.env.LAYER_BOX_CONFIG = join(tmpdir(), "layer-catalog-no-box.json");
const { applyManifest, catalogApps, createIntegration, manifestEnv, nodeFor, releaseOf } = await import("./catalog");
const { listCrons } = await import("./crons");
const { listDomains } = await import("./domains");
const { getProject, integrationFor, projectEnv, setMemory, setProjectEnv } = await import("./projects");

const MANIFEST: AppManifest = {
  id: "links",
  name: "Links",
  version: "0.1.0",
  summary: "Short links.",
  runtime: { kind: "node", node: "24", start: ["node", "server.js"], health: "/healthz", writable: [] },
  memory: { default: 128, min: 64 },
  env: { LINKS_ADMIN_TOKEN: { generate: "secret" }, LINKS_FALLBACK_URL: { setting: "fallbackUrl", default: "" }, LINKS_MODE: { value: "panel" } },
  services: ["sqlite"],
  cron: [],
  backup: ["data"],
};

describe("manifestEnv", () => {
  it("makes secrets once, keeps the owner's settings and other vars, and sets fixed values", () => {
    let n = 0;
    const secret = () => `secret-${++n}`;
    const first = manifestEnv(MANIFEST, {}, secret);
    expect(first).toEqual({ LINKS_ADMIN_TOKEN: "secret-1", LINKS_FALLBACK_URL: "", LINKS_MODE: "panel" });
    const owner = { ...first, LINKS_FALLBACK_URL: "https://example.com", LINKS_MODE: "edited", EXTRA: "mine" };
    expect(manifestEnv(MANIFEST, owner, secret)).toEqual({ LINKS_ADMIN_TOKEN: "secret-1", LINKS_FALLBACK_URL: "https://example.com", LINKS_MODE: "panel", EXTRA: "mine" });
    // A secret blanked by hand is made again; an empty setting is the owner's choice.
    expect(manifestEnv(MANIFEST, { ...first, LINKS_ADMIN_TOKEN: "" }, secret).LINKS_ADMIN_TOKEN).toBe("secret-2");
  });
});

describe("nodeFor", () => {
  const releases = async () => [
    { version: "26.1.0", lts: false },
    { version: "24.14.0", lts: true },
    { version: "22.22.0", lts: true },
  ];
  it("uses the server's Node for its major, else the newest LTS of the major asked for", async () => {
    expect(await nodeFor("24.11.0", "24.13.1", releases)).toBe("24.11.0");
    expect(await nodeFor("24", "24.13.1", releases)).toBe("24.13.1");
    expect(await nodeFor("22", "24.13.1", releases)).toBe("22.22.0");
    await expect(nodeFor("18", "24.13.1", releases)).rejects.toThrow(/no Node 18 release/);
    await expect(nodeFor("22", "24.13.1", () => Promise.reject(new Error("offline")))).rejects.toThrow(/Couldn't reach nodejs.org to find Node 22 \(offline\)/);
  });
});

describe("createIntegration", () => {
  it("makes a project from the catalog's newest version, with its free URL, env and cron jobs", async () => {
    const { project, version } = await createIntegration("hello");
    expect(version.version).toBe("0.1.0");
    expect(releaseOf(version)).toBe(version.sha256.slice(0, 40));
    expect(project).toMatchObject({
      slug: "hello",
      source: "catalog",
      catalogApp: "hello",
      autoDeploy: false,
      nodeVersion: "24.13.1",
      memoryMb: 64,
      runtime: { kind: "node", exec: ["node", "server.js"], healthPath: "/healthz", writablePaths: [] },
      domains: ["hello.203-0-113-7.sslip.io"],
    });
    expect(listDomains(project.id).map((d) => [d.host, d.role, d.status])).toEqual([["hello.203-0-113-7.sslip.io", "free", "active"]]);
    expect(projectEnv(project.id)).toEqual({ HELLO_GREETING: "Hello" });
    expect(listCrons(project.id).map((c) => [c.name, c.schedule, c.command])).toEqual([["tidy", "30 3 * * *", "node cron.js tidy"]]);
    expect(integrationFor("hello")?.id).toBe(project.id);
  });

  it("installs an app once, and only what the catalog lists", async () => {
    await expect(createIntegration("hello")).rejects.toThrow(/Hello is already installed/);
    await expect(createIntegration("nope")).rejects.toThrow(/doesn't list that app/);
  });
});

describe("applyManifest", () => {
  it("follows a newer version: how it starts, a higher memory floor, new env vars and cron jobs", async () => {
    const project = integrationFor("hello")!;
    setProjectEnv(project.id, { HELLO_GREETING: "Hi", MINE: "1" });
    setMemory(project.id, 64);
    const hello = (await catalogApps())[0]!.versions[0]!.manifest;
    const next: AppManifest = {
      ...hello,
      version: "0.2.0",
      runtime: { ...hello.runtime, start: ["node", "dist/server.js"], health: "/ready" },
      memory: { default: 128, min: 96 },
      env: { ...hello.env, HELLO_SECRET: { generate: "secret" } },
      cron: [...hello.cron, { name: "report", schedule: "@daily", command: "node cron.js report" }],
    };
    const notes = await applyManifest(project, next);
    expect(notes.join("")).toMatch(/Memory limit raised to 96 MB.*Added HELLO_SECRET to the environment/s);
    expect(getProject(project.id)).toMatchObject({ memoryMb: 96, runtime: { exec: ["node", "dist/server.js"], healthPath: "/ready" } });
    const env = projectEnv(project.id);
    expect(env).toMatchObject({ HELLO_GREETING: "Hi", MINE: "1" });
    expect(env.HELLO_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(listCrons(project.id).map((c) => c.name)).toEqual(["report", "tidy"]);
    // Again: nothing changes, the secret stays.
    expect(await applyManifest(getProject(project.id)!, next)).toEqual([]);
    expect(projectEnv(project.id).HELLO_SECRET).toBe(env.HELLO_SECRET);
  });
});

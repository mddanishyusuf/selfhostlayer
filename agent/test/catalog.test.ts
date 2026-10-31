import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { parseManifest } from "@layer/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appActions } from "../src/actions/app.ts";
import { buildActions } from "../src/actions/build.ts";
import { catalogActions, catalogUrl, parseCatalog } from "../src/actions/catalog.ts";
import { NO_IO } from "../src/context.ts";
import { SYSTEMD_RUN } from "../src/sandbox.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

const TARBALL = Buffer.from("a catalog app's tarball");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const MANIFEST = {
  id: "hello",
  name: "Hello",
  version: "0.1.0",
  summary: "Says hello, and counts visits in SQLite.",
  runtime: { kind: "node", node: "24", start: ["node", "server.js"], health: "/healthz", writable: ["cache"] },
  memory: { default: 128, min: 64 },
  env: { HELLO_SECRET: { generate: "secret" }, HELLO_GREETING: { setting: "greeting", default: "Hello" } },
  services: ["sqlite"],
  cron: [{ name: "tidy", schedule: "30 3 * * *", command: "node cron.js tidy" }],
  backup: ["data"],
};

let server: Server;
let base = "";
let catalog = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/catalog.json") return res.writeHead(200, { "Content-Type": "application/json" }).end(catalog);
    if (req.url === "/catalog/hello/0.1.0/hello-0.1.0.tar.gz") return res.writeHead(200).end(TARBALL);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const version = (over: Record<string, unknown> = {}) => ({
  version: "0.1.0",
  date: "2026-11-01",
  notes: "First version.",
  minPanel: "0.1.6",
  tarball: { url: `${base}/catalog/hello/0.1.0/hello-0.1.0.tar.gz`, sha256: sha(TARBALL) },
  manifest: MANIFEST,
  ...over,
});
const catalogOf = (...versions: Record<string, unknown>[]) => JSON.stringify({ apps: [{ id: "hello", versions }] });

let env: TestEnv;
beforeEach(async () => {
  env = testEnv();
  mkdirSync(dirname(env.paths.boxConfig), { recursive: true });
  writeFileSync(env.paths.boxConfig, JSON.stringify({ panelHost: "p.example.com", appsDomain: "p.example.com", publicIp: "203.0.113.7", version: "0.1.6", defaultNode: "24.13.1", updatesUrl: `${base}/releases.json` }));
  catalog = catalogOf(version());
  await appActions["app.create"]!.run({ slug: "hello" }, env.ctx, NO_IO);
});
afterEach(() => env.cleanup());

const fetchApp = (params: Record<string, unknown> = {}) => buildActions["catalog.fetch"]!.run({ slug: "hello", app: "hello", version: "0.1.0", ...params }, env.ctx, NO_IO) as Promise<any>;
const releases = () => join(env.paths.appsRoot, "hello", "releases");
const unpackCalls = () => env.spawner.calls.filter((c) => c[0] === SYSTEMD_RUN && c.includes("--unit=layer-fetch-hello.service"));

describe("parseManifest", () => {
  it("reads a manifest, with defaults for what it leaves out", () => {
    const m = parseManifest({ ...MANIFEST, memory: undefined, cron: undefined });
    expect(m).toMatchObject({ id: "hello", runtime: { start: ["node", "server.js"], writable: ["cache"] }, memory: { default: 256, min: 64 }, cron: [] });
    expect(m.env.HELLO_GREETING).toEqual({ setting: "greeting", default: "Hello" });
  });

  it("refuses what would reach a unit, an env file or a path unchecked", () => {
    expect(() => parseManifest({ ...MANIFEST, env: { PORT: { value: "1" } } })).toThrow(/env.PORT: is set by Self Host Layer/);
    expect(() => parseManifest({ ...MANIFEST, runtime: { ...MANIFEST.runtime, start: ["node", "server.js; rm -rf /"] } })).toThrow(/runtime.start\[1\]/);
    expect(() => parseManifest({ ...MANIFEST, runtime: { ...MANIFEST.runtime, start: ["bash", "start.sh"] } })).toThrow(/runtime.start\[0\]: must be node, npm or npx/);
    expect(() => parseManifest({ ...MANIFEST, memory: { default: 64, min: 32 } })).toThrow(/memory.min/);
    expect(() => parseManifest({ ...MANIFEST, runtime: { ...MANIFEST.runtime, writable: ["../etc"] } })).toThrow(/runtime.writable\[0\]/);
    expect(() => parseManifest({ ...MANIFEST, version: "latest" })).toThrow(/version/);
    expect(() => parseManifest({ ...MANIFEST, env: { HELLO_X: { value: "a\nb" } } })).toThrow(/env.HELLO_X.value/);
    expect(() => parseManifest({ ...MANIFEST, cron: [MANIFEST.cron[0], MANIFEST.cron[0]] })).toThrow(/listed twice/);
    expect(() => parseManifest({ ...MANIFEST, cron: [{ ...MANIFEST.cron[0], command: "node cron.js && curl x" }] })).toThrow(/cron\[0\].command/);
    expect(() => parseManifest({ ...MANIFEST, cron: [{ ...MANIFEST.cron[0], command: "sh tidy.sh" }] })).toThrow(/cron\[0\].command/);
    expect(() => parseManifest({ ...MANIFEST, services: ["mysql"] })).toThrow(/services\[0\]/);
  });
});

describe("the catalog", () => {
  it("lives beside the update feed unless the config names it", () => {
    expect(catalogUrl({ updatesUrl: "https://get.selfhostlayer.com/releases.json" } as never)).toBe("https://get.selfhostlayer.com/catalog.json");
    expect(catalogUrl({ updatesUrl: "https://a.example/releases.json", catalogUrl: "https://b.example/apps.json" } as never)).toBe("https://b.example/apps.json");
    expect(() => catalogUrl({} as never)).toThrow(/no catalog/);
  });

  it("only takes tarballs from its own address, and manifests that match their entry", () => {
    expect(() => parseCatalog(catalogOf(version({ tarball: { url: "https://elsewhere.example/hello.tar.gz", sha256: sha(TARBALL) } })), `${base}/catalog.json`)).toThrow(/catalog's own address/);
    expect(() => parseCatalog(catalogOf(version({ version: "0.2.0" })), `${base}/catalog.json`)).toThrow(/must describe hello 0.2.0/);
    expect(() => parseCatalog(catalogOf(version({ manifest: { ...MANIFEST, env: { PORT: { value: "1" } } } })), `${base}/catalog.json`)).toThrow(/manifest.env.PORT/);
    expect(() => parseCatalog("{}", `${base}/catalog.json`)).toThrow(/no apps list/);
  });

  it("lists apps for the panel without saying where tarballs live", async () => {
    const { apps } = (await catalogActions["catalog.list"]!.run({}, env.ctx, NO_IO)) as any;
    expect(apps[0]).toMatchObject({ id: "hello", name: "Hello", versions: [{ version: "0.1.0", minPanel: "0.1.6", sha256: sha(TARBALL), supported: true }] });
    expect(JSON.stringify(apps)).not.toContain("hello-0.1.0.tar.gz");
  });

  it("says which versions need a newer Self Host Layer", async () => {
    catalog = catalogOf(version({ version: "0.2.0", minPanel: "0.2.0", manifest: { ...MANIFEST, version: "0.2.0" } }), version());
    const { apps } = (await catalogActions["catalog.list"]!.run({}, env.ctx, NO_IO)) as any;
    expect(apps[0].versions.map((v: any) => [v.version, v.supported])).toEqual([["0.2.0", false], ["0.1.0", true]]);
  });
});

describe("catalog.fetch", () => {
  it("checks the tarball, then unpacks it as the app's user, offline, from stdin", async () => {
    env.spawner.respond = (_file, args) => {
      // What the unpack job does, for the test: the release appears.
      if (args.includes("--unit=layer-fetch-hello.service")) mkdirSync(join(releases(), sha(TARBALL).slice(0, 40)), { recursive: true });
      return { code: 0 };
    };
    const r = await fetchApp();
    expect(r).toMatchObject({ slug: "hello", release: sha(TARBALL).slice(0, 40), fetched: true, bytes: TARBALL.length });
    const call = unpackCalls()[0]!;
    expect(call).toContain("--uid=app-hello");
    expect(call).toContain("--property=IPAddressDeny=any");
    expect(call.join(" ")).toContain("tar -xzf - -C");
    // The download is gone once unpacked; nothing is left beside the agent.
    expect(readdirSync(env.paths.catalogDir)).toEqual([]);
    // Already there: nothing is downloaded or unpacked again.
    expect(await fetchApp()).toEqual({ slug: "hello", release: sha(TARBALL).slice(0, 40), fetched: false });
    expect(unpackCalls()).toHaveLength(1);
  });

  it("refuses a tarball that doesn't match the catalog, and writes nothing", async () => {
    catalog = catalogOf(version({ tarball: { url: `${base}/catalog/hello/0.1.0/hello-0.1.0.tar.gz`, sha256: "0".repeat(64) } }));
    await expect(fetchApp()).rejects.toThrow(/doesn't match the checksum in the catalog; nothing was installed/);
    expect(unpackCalls()).toEqual([]);
    expect(readdirSync(env.paths.catalogDir)).toEqual([]);
    expect(existsSync(join(releases(), "0".repeat(40)))).toBe(false);
  });

  it("reuses a release still on disk without asking the catalog, and refuses one the catalog no longer matches", async () => {
    const release = sha(TARBALL).slice(0, 40);
    mkdirSync(join(releases(), release), { recursive: true });
    catalog = "not reachable as JSON";
    expect(await fetchApp({ release })).toEqual({ slug: "hello", release, fetched: false });
    catalog = catalogOf(version());
    await expect(fetchApp({ release: "a".repeat(40) })).rejects.toThrow(/isn't the file this deployment was made for/);
    await expect(fetchApp({ release: "../etc" })).rejects.toThrow(/release/);
    expect(unpackCalls()).toEqual([]);
  });

  it("refuses a version that needs a newer Self Host Layer", async () => {
    catalog = catalogOf(version({ minPanel: "0.2.0" }));
    await expect(fetchApp()).rejects.toThrow(/needs Self Host Layer 0.2.0 or newer \(this server runs 0.1.6\)/);
    expect(unpackCalls()).toEqual([]);
  });

  it("refuses a catalog pointing elsewhere, and versions it doesn't list", async () => {
    catalog = catalogOf(version({ tarball: { url: "https://elsewhere.example/hello.tar.gz", sha256: sha(TARBALL) } }));
    await expect(fetchApp()).rejects.toThrow(/catalog's own address/);
    catalog = catalogOf(version());
    await expect(fetchApp({ version: "9.9.9" })).rejects.toThrow(/no hello 9.9.9/);
    await expect(fetchApp({ app: "nope" })).rejects.toThrow(/no app nope/);
    await expect(fetchApp({ slug: "missing" })).rejects.toThrow(/doesn't exist/);
    expect(unpackCalls()).toEqual([]);
  });
});

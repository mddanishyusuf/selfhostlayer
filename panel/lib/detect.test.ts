import { describe, expect, it } from "vitest";
import { detect, startCommand, type ProjectFiles } from "./detect";
import { parseRange, releasesFromIndex, resolveNodeVersion } from "./node-version";

// The package.json files of github.com/mddanishyusuf/selfhostlayer-examples,
// which build-e2e.sh builds and starts with exactly these settings.
const examples: Record<string, ProjectFiles> = {
  next: {
    "package.json": JSON.stringify({
      scripts: { dev: "next dev", build: "next build", start: "next start" },
      dependencies: { next: "16.4.3", react: "19.3.1", "react-dom": "19.3.1" },
    }),
    "package-lock.json": true,
    ".nvmrc": "24\n",
  },
  vite: {
    "package.json": JSON.stringify({
      type: "module",
      scripts: { dev: "vite", build: "vite build" },
      devDependencies: { vite: "^7.0.0" },
      packageManager: "pnpm@12.16.1+sha512.abc",
    }),
    "pnpm-lock.yaml": true,
    "index.html": true,
  },
  express: {
    "package.json": JSON.stringify({ packageManager: "yarn@1.22.22", scripts: { start: "node server.js" }, dependencies: { express: "^5.1.0" } }),
    "yarn.lock": true,
  },
  astro: {
    "package.json": JSON.stringify({
      scripts: { build: "astro build", start: "node dist/server/entry.mjs" },
      dependencies: { astro: "^5.0.0", "@astrojs/node": "^9.0.0" },
    }),
    "bun.lock": true,
  },
  nuxt: {
    "package.json": JSON.stringify({ scripts: { build: "nuxt build" }, dependencies: { nuxt: "^4.0.0", vue: "^3.5.0" } }),
    "package-lock.json": true,
  },
};

describe("detect: the example apps", () => {
  it("Next.js with npm", () => {
    const d = detect(examples.next!);
    expect(d).toMatchObject({ framework: "nextjs", packageManager: "npm", buildCommand: "npm run build", nodeRange: "24", nodeSource: ".nvmrc" });
    expect(d.runtime).toEqual({ kind: "node", exec: ["node", "node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1"], writablePaths: [".next/cache"], healthPath: "/" });
  });

  it("Vite with pnpm is a static SPA", () => {
    const d = detect(examples.vite!);
    expect(d).toMatchObject({ framework: "vite", packageManager: "pnpm", buildCommand: "pnpm run build" });
    expect(d.runtime).toEqual({ kind: "static", outputDir: "dist", spa: true });
  });

  it("Express with yarn runs node directly, no build", () => {
    const d = detect(examples.express!);
    expect(d).toMatchObject({ framework: "node-server", packageManager: "yarn", buildCommand: null, warnings: [] });
    expect(d.runtime).toMatchObject({ kind: "node", exec: ["node", "server.js"] });
  });

  it("Astro with the Node adapter and bun", () => {
    const d = detect(examples.astro!);
    expect(d).toMatchObject({ framework: "astro-node", packageManager: "bun", buildCommand: "bun run build" });
    expect(d.runtime).toMatchObject({ exec: ["node", "dist/server/entry.mjs"] });
  });

  it("Nuxt with npm", () => {
    const d = detect(examples.nuxt!);
    expect(d).toMatchObject({ framework: "nuxt", packageManager: "npm", buildCommand: "npm run build" });
    expect(d.runtime).toMatchObject({ exec: ["node", ".output/server/index.mjs"] });
  });
});

describe("detect: other projects", () => {
  const pkg = (p: object, extra: ProjectFiles = {}) => detect({ "package.json": JSON.stringify(p), ...extra });

  it("Astro without an adapter is static, and not an SPA", () => {
    expect(pkg({ scripts: { build: "astro build" }, dependencies: { astro: "5" } }).runtime).toEqual({ kind: "static", outputDir: "dist", spa: false });
  });

  it("Create React App serves build/ as an SPA", () => {
    expect(pkg({ scripts: { build: "react-scripts build" }, dependencies: { "react-scripts": "5" } }).runtime).toEqual({ kind: "static", outputDir: "build", spa: true });
  });

  it("React Router and Remix run their own servers", () => {
    expect(pkg({ dependencies: { "@react-router/serve": "7" } }).runtime).toMatchObject({ exec: ["node", "node_modules/@react-router/serve/bin.js", "build/server/index.js"] });
    expect(pkg({ dependencies: { "@remix-run/serve": "2" } }).framework).toBe("remix");
  });

  it("a Vite app with its own start script is a server, not static", () => {
    expect(pkg({ scripts: { build: "vite build", start: "node server.js" }, devDependencies: { vite: "7" } }).runtime.kind).toBe("node");
  });

  it("plain HTML without package.json is static", () => {
    expect(detect({ "index.html": true })).toMatchObject({ framework: "static-html", buildCommand: null, runtime: { kind: "static", outputDir: "." } });
  });

  it("warns when there's nothing to go on", () => {
    expect(detect({}).warnings[0]).toMatch(/root directory/);
    expect(detect({ "package.json": "{nope" }).warnings[0]).toMatch(/valid JSON/);
  });

  it("picks the package manager: packageManager field, then lockfiles, then npm", () => {
    expect(pkg({ packageManager: "bun@1.3.0" }, { "yarn.lock": true }).packageManager).toBe("bun");
    expect(pkg({}, { "pnpm-lock.yaml": true }).packageManager).toBe("pnpm");
    expect(pkg({}, { "bun.lockb": true }).packageManager).toBe("bun");
    expect(pkg({}).packageManager).toBe("npm");
  });

  it("reads the Node version from .nvmrc, .node-version, then engines", () => {
    expect(pkg({ engines: { node: ">=20" } }, { ".node-version": "v22.11.0\n" })).toMatchObject({ nodeRange: "v22.11.0", nodeSource: ".node-version" });
    expect(pkg({ engines: { node: ">=20" } })).toMatchObject({ nodeRange: ">=20", nodeSource: "engines.node" });
    expect(pkg({})).toMatchObject({ nodeRange: null, nodeSource: null });
  });
});

describe("startCommand", () => {
  it("runs plain node start scripts directly", () => {
    expect(startCommand({ scripts: { start: "node --enable-source-maps dist/main.js" } })).toEqual({ exec: ["node", "--enable-source-maps", "dist/main.js"] });
  });

  it("falls back to main, then npm start, with a warning", () => {
    expect(startCommand({ main: "app.js", scripts: { start: "PORT=$PORT node app.js" } }).exec).toEqual(["node", "app.js"]);
    expect(startCommand({ scripts: { start: "tsx src/index.ts" } })).toMatchObject({ exec: ["npm", "start"], warning: expect.stringContaining("npm") });
    expect(startCommand({}).exec).toEqual(["node", "index.js"]);
  });

  it("runs node after leading variables, which belong on the Environment page", () => {
    // kagaz-api's: main says index.js, which doesn't exist.
    expect(startCommand({ main: "index.js", scripts: { start: "NODE_ENV=production node server.js" } })).toEqual({ exec: ["node", "server.js"] });
    expect(startCommand({ scripts: { start: "NODE_ENV=production TZ=UTC node dist/main.js" } })).toEqual({ exec: ["node", "dist/main.js"], warning: "The start script sets TZ=UTC: add it on the Environment page." });
  });

  it("never treats shell syntax as a plain node command", () => {
    expect(startCommand({ scripts: { start: "node a.js && node b.js" } }).exec).toEqual(["npm", "start"]);
    expect(startCommand({ scripts: { start: "node $(cat entry)" } }).exec).toEqual(["npm", "start"]);
  });
});

describe("resolveNodeVersion", () => {
  const releases = releasesFromIndex([
    { version: "v26.1.0", lts: false },
    { version: "v24.13.1", lts: "Krypton" },
    { version: "v24.12.0", lts: "Krypton" },
    { version: "v23.11.1", lts: false },
    { version: "v22.23.4", lts: "Jod" },
    { version: "v22.11.0", lts: "Jod" },
    { version: "v20.19.5", lts: "Iron" },
  ]);

  it.each([
    ["24", "24.13.1"],
    ["22.x", "22.23.4"],
    ["v22.11.0", "22.11.0"],
    ["22.11", "22.11.0"],
    [">=20", "24.13.1"],
    [">= 20 < 24", "22.23.4"],
    ["^22.5", "22.23.4"],
    ["~24.12", "24.12.0"],
    ["18 - 22", "22.23.4"],
    ["20 || 22", "22.23.4"],
    ["lts/*", "24.13.1"],
    ["node", "24.13.1"],
    ["23", "23.11.1"],
    ["26", "26.1.0"],
  ])("%s → %s", (range, expected) => {
    expect(resolveNodeVersion(range, releases)).toBe(expected);
  });

  it("returns null for ranges nothing matches or it can't read", () => {
    expect(resolveNodeVersion("12", releases)).toBeNull();
    expect(resolveNodeVersion("banana", releases)).toBeNull();
    expect(parseRange("@@")).toBeNull();
  });
});

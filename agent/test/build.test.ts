import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appActions } from "../src/actions/app.ts";
import { allowedSourceRedirect, BUILD_SCRIPT, buildActions, pickPrunable, tarballUrl } from "../src/actions/build.ts";
import { bunAsset } from "../src/actions/tool.ts";
import { NO_IO, type CallIO } from "../src/context.ts";
import { sandboxArgs, SYSTEMD_RUN } from "../src/sandbox.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

const SHA = "a".repeat(40);
let env: TestEnv;

beforeEach(async () => {
  env = testEnv();
  await appActions["app.create"]!.run({ slug: "hello" }, env.ctx, NO_IO);
  mkdirSync(join(env.paths.appsRoot, "hello", "releases", SHA), { recursive: true });
  mkdirSync(join(env.paths.nodeRoot, "24.13.1", "bin"), { recursive: true });
  writeFileSync(join(env.paths.nodeRoot, "24.13.1", "bin", "node"), "");
});
afterEach(() => env.cleanup());

const build = (params: Record<string, unknown>, io: CallIO = NO_IO) =>
  buildActions["build.run"]!.run({ slug: "hello", sha: SHA, nodeVersion: "24.13.1", packageManager: "npm", ...params }, env.ctx, io) as Promise<any>;

describe("sandboxArgs", () => {
  const args = sandboxArgs({
    unit: "layer-build-hello.service",
    user: "app-hello",
    cwd: "/srv/apps/hello/releases/x",
    readWrite: ["/srv/apps/hello/releases/x", "/srv/apps/hello/cache"],
    env: { HOME: "/srv/apps/hello/cache/home", LAYER_BUILD_CMD: "npm run build" },
    envFiles: ["/etc/layer/apps/hello/app.env"],
    memoryMb: 1536,
    timeoutSec: 1200,
    network: true,
    command: ["/bin/bash", "-c", "echo hi"],
  });

  it("runs as the app user, never root, and streams output", () => {
    expect(args).toContain("--uid=app-hello");
    expect(args).toContain("--gid=app-hello");
    expect(args).toContain("--pipe");
    expect(args).toContain("--wait");
    expect(args.slice(args.indexOf("--") + 1)).toEqual(["/bin/bash", "-c", "echo hi"]);
  });

  it("locks the job down like an app unit, with limits", () => {
    for (const p of [
      "NoNewPrivileges=yes",
      "CapabilityBoundingSet=",
      "ProtectSystem=strict",
      "ReadWritePaths=/srv/apps/hello/releases/x /srv/apps/hello/cache",
      "ProtectHome=yes",
      "PrivateTmp=yes",
      "SystemCallFilter=@system-service",
      "MemoryMax=1536M",
      "RuntimeMaxSec=1200",
      "CPUWeight=20",
      "EnvironmentFile=-/etc/layer/apps/hello/app.env",
    ]) {
      expect(args).toContain(`--property=${p}`);
    }
    // Left out on purpose: it breaks GNU tar on Ubuntu 26.04 (openat2 → ENOSYS).
    expect(args.join(" ")).not.toContain("RestrictSUIDSGID");
  });

  it("cuts the network for jobs that don't need it", () => {
    const offline = sandboxArgs({ unit: "u", user: "app-x", cwd: "/", readWrite: ["/x"], env: {}, memoryMb: 256, timeoutSec: 60, network: false, command: ["true"] });
    expect(offline).toContain("--property=IPAddressDeny=any");
    expect(offline).toContain("--property=RestrictAddressFamilies=AF_UNIX");
    expect(args).not.toContain("--property=IPAddressDeny=any");
  });

  it("passes the command on as written, with every $ escaped from systemd", () => {
    const script = 'x=a@b; echo "${x%%@*}" "${DATABASE_URL:-}" $HOME $$';
    const run = sandboxArgs({ unit: "u", user: "app-x", cwd: "/", readWrite: ["/x"], env: {}, memoryMb: 256, timeoutSec: 60, network: false, command: ["/bin/sh", "-c", script] });
    expect(run.slice(run.indexOf("--") + 1)).toEqual(["/bin/sh", "-c", 'x=a@b; echo "$${x%%@*}" "$${DATABASE_URL:-}" $$HOME $$$$']);
  });
});

describe("source URLs", () => {
  it("builds the API tarball URL from validated parts", () => {
    expect(tarballUrl("mddanishyusuf", "selfhostlayer-examples", SHA)).toBe(
      `https://api.github.com/repos/mddanishyusuf/selfhostlayer-examples/tarball/${SHA}`,
    );
  });

  it("follows only GitHub's redirect to codeload over HTTPS", () => {
    expect(allowedSourceRedirect("https://codeload.github.com/o/r/legacy.tar.gz/abc?token=x")?.hostname).toBe("codeload.github.com");
    for (const bad of [null, "", "http://codeload.github.com/x", "https://evil.com/x", "https://codeload.github.com.evil.com/x", "file:///etc/passwd", "https://169.254.169.254/latest"]) {
      expect(allowedSourceRedirect(bad)).toBeNull();
    }
  });

  it("accepts both GitHub installation token formats", async () => {
    const fetchSource = (token: string) =>
      buildActions["source.fetch"]!.run({ slug: "hello", owner: "o", repo: "r", sha: SHA, token }, env.ctx, NO_IO);
    // The release is already on disk in this test, so a token that passes
    // validation returns early with fetched: false (no network needed).
    const jwtPart = (n: number) => "A1b2C3d4-_".repeat(n);
    const stateless = `ghs_1234567_${jwtPart(4)}.${jwtPart(40)}.${jwtPart(8)}`;
    expect(stateless.length).toBeGreaterThan(500);
    for (const token of ["ghs_16C7e42F292c6912E7710c838347Ae178B4a", stateless]) {
      await expect(fetchSource(token)).resolves.toMatchObject({ fetched: false });
    }
    await expect(fetchSource("ghs_" + "x".repeat(5000))).rejects.toThrow(/token/);
    await expect(fetchSource("Bearer ghs_abc def")).rejects.toThrow(/token/);
  });

  it("rejects bad source parameters before any network call", async () => {
    const fetchSource = (p: Record<string, unknown>) =>
      buildActions["source.fetch"]!.run({ slug: "hello", owner: "o", repo: "r", sha: SHA, ...p }, env.ctx, NO_IO);
    await expect(fetchSource({ owner: "a/b" })).rejects.toThrow(/owner/);
    await expect(fetchSource({ repo: ".." })).rejects.toThrow(/repo/);
    await expect(fetchSource({ sha: "main" })).rejects.toThrow(/sha/);
    await expect(fetchSource({ token: "x\ny" })).rejects.toThrow(/token/);
  });

  it("never writes the token to the audit log", () => {
    const redacted = buildActions["source.fetch"]!.redact!({ slug: "hello", token: "ghs_secret123456789012345" }) as any;
    expect(redacted.token).toBe("[redacted]");
    expect(JSON.stringify(redacted)).not.toContain("ghs_secret");
  });
});

describe("build.run", () => {
  it("runs install then build as two sandboxed steps, with step markers", async () => {
    let output = "";
    const io: CallIO = { emit: (c) => (output += c), signal: new AbortController().signal };
    const res = await build({ buildCommand: "npm run build" }, io);
    expect(res.steps.map((s: any) => s.name)).toEqual(["install", "build"]);
    const runs = env.spawner.calls.filter(([file]) => file === SYSTEMD_RUN);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.at(-1)).toBe("install");
    expect(runs[1]!.at(-1)).toBe("build");
    expect(runs[1]).toContain("--setenv=LAYER_BUILD_CMD=npm run build");
    expect(runs[0]).toContain("--uid=app-hello");
    expect(output).toContain("::layer::step install\n");
    expect(output).toMatch(/::layer::step-end build 0 \d+\n/);
  });

  it("reports a cancelled build as cancelled even when the job exits 0", async () => {
    // systemd treats the SIGTERM from `systemctl stop` as a clean exit.
    env.fake.respond = (file, args) =>
      file.endsWith("systemctl") && args[0] === "is-active" ? { code: 0, stdout: "active\n", stderr: "" } : undefined;
    env.spawner.respond = async (_f, args) => {
      if (args.at(-1) === "build") await buildActions["build.cancel"]!.run({ slug: "hello" }, env.ctx, NO_IO);
      return { code: 0 };
    };
    await expect(build({ buildCommand: "sleep 300" })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("skips the build step when there is no build command", async () => {
    const res = await build({});
    expect(res.steps.map((s: any) => s.name)).toEqual(["install"]);
  });

  it("puts the pinned Node first on PATH and keeps caches in the app's cache dir", async () => {
    await build({});
    const run = env.spawner.calls.find(([f]) => f === SYSTEMD_RUN)!;
    const path = run.find((a) => a.startsWith("--setenv=PATH="))!;
    expect(path).toMatch(new RegExp(`^--setenv=PATH=${join(env.paths.nodeRoot, "24.13.1", "bin")}:`));
    expect(run).toContain(`--setenv=npm_config_cache=${join(env.paths.appsRoot, "hello", "cache", "npm")}`);
    expect(run).toContain(`--working-directory=${join(env.paths.appsRoot, "hello", "releases", SHA)}`);
  });

  it("runs in the root dir for monorepos", async () => {
    await build({ rootDir: "apps/web" });
    const run = env.spawner.calls.find(([f]) => f === SYSTEMD_RUN)!;
    expect(run).toContain(`--working-directory=${join(env.paths.appsRoot, "hello", "releases", SHA, "apps", "web")}`);
  });

  it("reports which step failed", async () => {
    env.spawner.respond = (_f, args) => (args.at(-1) === "build" ? { code: 1 } : undefined);
    await expect(build({ buildCommand: "npm run build" })).rejects.toMatchObject({ code: "build_failed" });
    env.spawner.respond = (_f, args) => (args.at(-1) === "install" ? { code: 1 } : undefined);
    await expect(build({ buildCommand: "npm run build" })).rejects.toMatchObject({ code: "install_failed" });
  });

  it("needs a fetched release, an installed Node, and bun for bun projects", async () => {
    await expect(build({ sha: "b".repeat(40) })).rejects.toMatchObject({ code: "not_found" });
    await expect(build({ nodeVersion: "22.0.0" })).rejects.toMatchObject({ code: "not_found" });
    await expect(build({ packageManager: "bun" })).rejects.toMatchObject({ code: "tool_missing" });
  });

  it("refuses to start on a nearly full disk", async () => {
    env.paths.minFreeDisk = 1.01; // more than 100% free: impossible
    await expect(build({})).rejects.toMatchObject({ code: "disk_full" });
  });

  it("validates commands and limits", async () => {
    await expect(build({ buildCommand: "a\nb" })).rejects.toThrow(/buildCommand/);
    await expect(build({ rootDir: "../other" })).rejects.toThrow(/rootDir/);
    await expect(build({ memoryMb: 64 })).rejects.toThrow(/memoryMb/);
    await expect(build({ packageManager: "deno" })).rejects.toThrow(/packageManager/);
  });

  it("keeps the build script free of project input", () => {
    // Project settings arrive only as env vars; the script itself is constant.
    expect(BUILD_SCRIPT).toContain('exec bash -c "$LAYER_BUILD_CMD"');
    expect(BUILD_SCRIPT).toContain("npm ci");
    expect(BUILD_SCRIPT).toContain("falling back to npm install");
  });
});

describe("pickPrunable", () => {
  const sha = (c: string) => c.repeat(40);
  const entries = [
    { name: sha("1"), mtimeMs: 1 },
    { name: sha("2"), mtimeMs: 2 },
    { name: sha("3"), mtimeMs: 3 },
    { name: sha("4"), mtimeMs: 4 },
    { name: `${sha("5")}.partial`, mtimeMs: 5 },
    { name: "notes.txt", mtimeMs: 6 },
  ];

  it("keeps the newest N and anything a color points at, removes leftovers", () => {
    expect(pickPrunable(entries, new Set([sha("1")]), 2).sort()).toEqual([`${sha("5")}.partial`, sha("2")].sort());
  });

  it("never touches files it doesn't recognize", () => {
    expect(pickPrunable(entries, new Set(), 1)).not.toContain("notes.txt");
  });
});

describe("bunAsset", () => {
  it("uses the baseline x64 build, which runs on every x86-64 CPU", () => {
    expect(bunAsset("x64")).toBe("bun-linux-x64-baseline.zip");
    expect(bunAsset("arm64")).toBe("bun-linux-aarch64.zip");
    expect(() => bunAsset("ia32")).toThrow();
  });
});

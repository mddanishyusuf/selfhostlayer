import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appActions } from "../src/actions/app.ts";
import { proxyActions } from "../src/actions/proxy.ts";
import { COPY_SCRIPT, staticActions } from "../src/actions/static.ts";
import { NO_IO } from "../src/context.ts";
import { SYSTEMD_RUN } from "../src/sandbox.ts";
import { parseLiveMarker, renderStaticSite } from "../src/templates/caddy-site.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

const sha = (c: string) => c.repeat(40);
let env: TestEnv;

beforeEach(async () => {
  env = testEnv();
  await appActions["app.create"]!.run({ slug: "site" }, env.ctx, NO_IO);
  for (const c of ["a", "b", "c", "d", "e"]) mkdirSync(join(env.paths.appsRoot, "site", "releases", sha(c), "dist"), { recursive: true });
});
afterEach(() => env.cleanup());

const publish = (p: Record<string, unknown>) =>
  staticActions["static.publish"]!.run({ slug: "site", sha: sha("a"), outputDir: "dist", ...p }, env.ctx, NO_IO) as Promise<any>;
const siteDir = () => join(env.paths.staticRoot, "site");

describe("renderStaticSite", () => {
  it("serves files with SPA fallback and long caching for hashed assets", async () => {
    const site = renderStaticSite({ slug: "site", domains: ["site.example.com"], spa: true, root: "/srv/static/site/current" });
    await expect(site).toMatchFileSnapshot("./__snapshots__/site-spa.caddy");
    expect(parseLiveMarker(site)).toEqual({ slug: "site", color: "static", port: null });
  });

  it("serves clean URLs and a 404 page for multi-page sites", () => {
    const site = renderStaticSite({ slug: "site", domains: ["site.example.com"], spa: false, root: "/srv/static/site/current" });
    expect(site).toContain("try_files {path} {path}.html {path}/\n");
    expect(site).toContain("rewrite * /404.html");
    expect(site).not.toContain("/index.html");
  });
});

describe("static.publish", () => {
  it("copies the output as the app user with cp -L, into a folder only Caddy can read", async () => {
    await publish({ rootDir: "web" }).catch(() => {});
    const run = env.spawner.calls.find(([f]) => f === SYSTEMD_RUN)!;
    expect(run).toContain("--uid=app-site");
    const dest = run.find((a) => a.startsWith("--property=ReadWritePaths="))!.split("=")[2]!;
    expect(dest.startsWith(join(siteDir(), `${sha("a")}-`))).toBe(true);
    expect(run).toContain("--property=IPAddressDeny=any");
    expect(run.slice(run.indexOf("--") + 1)).toEqual([
      "/bin/sh", "-c", COPY_SCRIPT, "layer-publish",
      join(env.paths.appsRoot, "site", "releases", sha("a"), "web", "dist"),
      dest,
      "dist",
    ]);
    expect(COPY_SCRIPT).toContain("cp -rL");
    expect(COPY_SCRIPT).toContain("! -type f ! -type d");
  });

  const live = () => readlinkSync(join(siteDir(), "current"));

  it("points current at the new release atomically", async () => {
    const res = await publish({});
    expect(live().startsWith(`${sha("a")}-`)).toBe(true);
    expect(res.live).toBe(live());
    await publish({ sha: sha("b") });
    expect(live().startsWith(`${sha("b")}-`)).toBe(true);
  });

  it("keeps the live version when the copy fails, even for the same commit", async () => {
    await publish({});
    const before = live();
    env.spawner.respond = () => ({ code: 1 });
    await expect(publish({})).rejects.toMatchObject({ code: "publish_failed" });
    expect(live()).toBe(before);
    expect(existsSync(join(siteDir(), before))).toBe(true);
    expect(readdirSync(siteDir()).filter((e) => e.startsWith(sha("a")))).toEqual([before]);
  });

  it("keeps only the newest 3 published releases", async () => {
    let t = 1_700_000_000;
    for (const c of ["a", "b", "c", "d", "e"]) {
      await publish({ sha: sha(c) });
      utimesSync(join(siteDir(), live()), t, t);
      t += 60;
    }
    const kept = readdirSync(siteDir()).filter((e) => e !== "current").map((e) => e[0]).sort();
    expect(kept).toEqual(["c", "d", "e"]);
  });

  it("accepts '.' for sites without a build, and validates the rest", async () => {
    await publish({ outputDir: "." });
    await expect(publish({ outputDir: "../../etc" })).rejects.toThrow(/outputDir/);
    await expect(publish({ sha: sha("f") })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("proxy.set for static sites", () => {
  it("needs a published site, then serves it and shows up as static", async () => {
    const set = (p: Record<string, unknown>) => proxyActions["proxy.set"]!.run({ slug: "site", domains: ["site.example.com"], static: true, ...p }, env.ctx, NO_IO);
    await expect(set({ spa: true })).rejects.toMatchObject({ code: "not_found" });
    await publish({});
    await set({ spa: true });
    const file = readFileSync(join(env.paths.caddySitesDir, "site.caddy"), "utf8");
    expect(file).toContain(`root * ${join(siteDir(), "current")}`);
    const { apps } = (await appActions["app.list"]!.run({}, env.ctx, NO_IO)) as any;
    expect(apps[0]).toMatchObject({ slug: "site", live: "static", domains: ["site.example.com"] });
  });
});

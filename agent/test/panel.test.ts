import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ActionName } from "@layer/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { panelActions } from "../src/actions/panel.ts";
import { NO_IO } from "../src/context.ts";
import { BIN } from "../src/exec.ts";
import { assertRanges, renderPanelSite } from "../src/templates/caddy-panel.ts";
import { testEnv, type TestEnv } from "./helpers.ts";

let env: TestEnv;
const box = { panelHost: "37-27-25-45.sslip.io", appsDomain: "37-27-25-45.sslip.io", publicIp: "37.27.25.45", version: "0.1.0", defaultNode: "24.13.1" };
beforeEach(() => {
  env = testEnv();
  mkdirSync(dirname(env.paths.boxConfig), { recursive: true });
  writeFileSync(env.paths.boxConfig, JSON.stringify(box));
});
afterEach(() => env.cleanup());

const run = (action: ActionName, params: Record<string, unknown> = {}) => panelActions[action]!.run(params, env.ctx, NO_IO) as Promise<any>;
const site = () => readFileSync(join(env.paths.caddySitesDir, "_panel.caddy"), "utf8");
const config = () => JSON.parse(readFileSync(env.paths.boxConfig, "utf8"));

describe("renderPanelSite", () => {
  it("serves the panel on its hosts and redirects old addresses, keeping the path", () => {
    const out = renderPanelSite({ hosts: ["panel.example.com", "next.example.com"], redirects: ["old.example.com"], internalTls: false });
    expect(out).toContain("panel.example.com, next.example.com {\n\tencode zstd gzip\n\treverse_proxy unix//run/layer-panel/panel.sock");
    expect(out).toContain("old.example.com {\n\tredir https://panel.example.com{uri} permanent\n}");
    expect(out).not.toContain("tls internal");
  });

  it("uses the local CA on test boxes, for redirects too", () => {
    const out = renderPanelSite({ hosts: ["a.internal.test"], redirects: ["b.internal.test"], internalTls: true });
    expect(out.match(/tls internal/g)).toHaveLength(2);
  });

  it("refuses bad or clashing hosts", () => {
    expect(() => renderPanelSite({ hosts: [], redirects: [], internalTls: false })).toThrow(/hostnames/);
    expect(() => renderPanelSite({ hosts: ["Panel.Example.com"], redirects: [], internalTls: false })).toThrow(/lowercase hostname/);
    expect(() => renderPanelSite({ hosts: ["a.example.com"], redirects: ["a.example.com"], internalTls: false })).toThrow(/both serve/);
    expect(() => renderPanelSite({ hosts: ["a.example.com\n}"], redirects: [], internalTls: false })).toThrow();
  });
});

describe("panel.site", () => {
  it("writes the site from the config and reloads Caddy", async () => {
    const result = await run("panel.site");
    expect(result).toEqual({ host: box.panelHost, pending: [], aliases: [], internalTls: false, allow: [] });
    expect(site()).toContain(`${box.panelHost} {`);
    expect(env.fake.calls).toContainEqual([BIN.systemctl, "reload", "caddy"]);
  });

  it("keeps an older install's local CA and records it in the config", async () => {
    mkdirSync(env.paths.caddySitesDir, { recursive: true });
    writeFileSync(join(env.paths.caddySitesDir, "_panel.caddy"), `${box.panelHost} {\n\ttls internal\n\treverse_proxy unix//run/layer-panel/panel.sock\n}\n`);
    await run("panel.site");
    expect(site()).toContain("tls internal");
    expect(config().internalTls).toBe(true);
  });
});

describe("panel.address", () => {
  it("serves a second address while the panel moves, then redirects the old one", async () => {
    let result = await run("panel.address", { hosts: [box.panelHost, "panel.example.com"], redirects: [] });
    expect(result).toMatchObject({ host: box.panelHost, pending: ["panel.example.com"], aliases: [] });
    expect(site()).toContain(`${box.panelHost}, panel.example.com {`);

    result = await run("panel.address", { hosts: ["panel.example.com"], redirects: [box.panelHost] });
    expect(result).toMatchObject({ host: "panel.example.com", pending: [], aliases: [box.panelHost] });
    expect(config()).toMatchObject({ panelHost: "panel.example.com", panelAliases: [box.panelHost], appsDomain: box.appsDomain, publicIp: box.publicIp });
    expect(site()).toContain(`${box.panelHost} {\n\tredir https://panel.example.com{uri} permanent`);
  });

  it("puts both files back when Caddy refuses the new config", async () => {
    await run("panel.site");
    const before = { site: site(), config: readFileSync(env.paths.boxConfig, "utf8") };
    let reloads = 0;
    env.fake.respond = (f, args) => (f === BIN.systemctl && args[0] === "reload" && ++reloads === 1 ? { code: 1, stdout: "", stderr: "bad" } : undefined);
    await expect(run("panel.address", { hosts: ["panel.example.com"], redirects: [box.panelHost] })).rejects.toThrow("Caddy refused");
    expect(site()).toBe(before.site);
    expect(readFileSync(env.paths.boxConfig, "utf8")).toBe(before.config);
  });

  it("refuses a host that would serve and redirect at once", async () => {
    await expect(run("panel.address", { hosts: ["panel.example.com"], redirects: ["panel.example.com"] })).rejects.toThrow(/both serve/);
  });
});

describe("panel.access", () => {
  it("answers only allowed addresses, except GitHub's webhook", async () => {
    const result = await run("panel.access", { allow: ["203.0.113.7", "100.64.0.0/10", "fd7a:115c:a1e0::/48"] });
    expect(result.allow).toEqual(["203.0.113.7", "100.64.0.0/10", "fd7a:115c:a1e0::/48"]);
    expect(config().panelAllow).toEqual(result.allow);
    expect(site()).toContain("\t@outside {\n\t\tnot remote_ip 203.0.113.7 100.64.0.0/10 fd7a:115c:a1e0::/48\n\t\tnot path /api/github/webhook\n\t}\n\trespond @outside");
  });

  it("goes back to anyone with an empty list, keeping the address", async () => {
    await run("panel.address", { hosts: ["panel.example.com"], redirects: [] });
    await run("panel.access", { allow: ["203.0.113.7"] });
    await run("panel.access", { allow: [] });
    expect(site()).not.toContain("@outside");
    expect(config()).toMatchObject({ panelHost: "panel.example.com", panelAllow: [] });
  });

  it("only takes IPs and ranges", () => {
    expect(assertRanges(["10.0.0.0/8", "2001:db8::1"])).toEqual(["10.0.0.0/8", "2001:db8::1"]);
    for (const bad of ["10.0.0.0/33", "10.0.0.1/24/1", "example.com", "1.2.3.4 5.6.7.8", "::/129", ""]) expect(() => assertRanges([bad]), bad).toThrow();
    expect(() => assertRanges(["1.2.3.4", "1.2.3.4"])).toThrow(/duplicates/);
  });
});

describe("apps.domain", () => {
  it("changes the base of the free URLs, keeping the rest of the config", async () => {
    expect(await run("apps.domain", { domain: "apps.example.com" })).toEqual({ appsDomain: "apps.example.com", previous: box.appsDomain });
    expect(config()).toMatchObject({ ...box, appsDomain: "apps.example.com" });
    expect(await run("apps.domain", { domain: "internal" })).toMatchObject({ appsDomain: "internal" });
    await expect(run("apps.domain", { domain: "*.example.com" })).rejects.toThrow(/lowercase hostname/);
  });
});

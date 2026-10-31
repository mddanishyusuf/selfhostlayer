import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.ts";
import { cleanPath, propsOf, screenOf, VISIT_GAP } from "../src/ingest.ts";
import { SCRIPT } from "../src/script.ts";
import { checkDomain } from "../src/sites.ts";
import { live, prune, stats } from "../src/stats.ts";

const TOKEN = "a".repeat(64);
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

let app: App;
let base = "";
let dataDir = "";
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "analytics-"));
  app = createApp({ dataDir, token: TOKEN, releaseDir: dataDir, version: "test", flushMs: 0 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const admin = (path: string, init: RequestInit = {}) => fetch(`${base}/_admin/${path}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers } });
const send = (body: unknown, ua = CHROME, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/event`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "text/plain", "User-Agent": ua, ...headers } });
/** A request as Caddy forwards it, for calling the ingest directly with a chosen time. */
const req = (ua: string, ip: string) => ({ headers: { "user-agent": ua, "x-forwarded-for": ip }, socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;

describe("the script", () => {
  /** Runs /script.js in a pretend page; returns what it sent. */
  function page(o: { webdriver?: boolean; hostname?: string } = {}) {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
    const location = { href: "https://example.com/pricing?utm_source=x", pathname: "/pricing", hostname: o.hostname ?? "example.com", protocol: "https:" };
    const history = { pushState: (_s: unknown, _t: unknown, path: string) => Object.assign(location, { pathname: path, href: `https://example.com${path}` }) };
    const window: Record<string, unknown> = { innerWidth: 1280, addEventListener: (n: string, f: () => void) => (listeners[n] ??= []).push(f) };
    const document = {
      currentScript: { src: "https://a.example.org/script.js", getAttribute: (n: string) => (n === "data-site" ? "example.com" : null) },
      referrer: "https://news.ycombinator.com/",
      visibilityState: "visible",
      addEventListener: (n: string, f: () => void) => (listeners[n] ??= []).push(f),
      removeEventListener: () => {},
    };
    const navigator = { webdriver: o.webdriver ?? false, sendBeacon: (url: string, body: string) => (sent.push({ url, body: JSON.parse(body) }), true) };
    runInNewContext(SCRIPT, { window, document, navigator, location, history, fetch: () => Promise.resolve() });
    return { sent, window: window as { shl: { track: (n: string, p?: unknown) => void } }, history, listeners, document };
  }

  it("sends a pageview on load and on route changes, and custom events, to its own address", () => {
    const p = page();
    expect(p.sent[0]).toEqual({ url: "https://a.example.org/api/event", body: { n: "pageview", s: "example.com", u: "https://example.com/pricing?utm_source=x", r: "https://news.ycombinator.com/", w: 1280 } });
    p.history.pushState(null, "", "/signup");
    p.history.pushState(null, "", "/signup");
    p.window.shl.track("Signup", { plan: "pro" });
    p.document.visibilityState = "hidden";
    for (const f of p.listeners.visibilitychange ?? []) f();
    expect(p.sent.map((s) => [s.body.n, s.body.u])).toEqual([
      ["pageview", "https://example.com/pricing?utm_source=x"],
      ["pageview", "https://example.com/signup"],
      ["Signup", "https://example.com/signup"],
      ["ping", "https://example.com/signup"],
    ]);
    expect(p.sent[2]!.body.p).toEqual({ plan: "pro" });
  });

  it("sends nothing from automated browsers or localhost", () => {
    expect(page({ webdriver: true }).sent).toEqual([]);
    expect(page({ hostname: "localhost" }).sent).toEqual([]);
  });

  it("is served small, cached for an hour", async () => {
    const res = await fetch(`${base}/script.js`);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect((await res.text()).length).toBeLessThan(2048);
  });
});

describe("events", () => {
  beforeEach(async () => {
    await admin("sites", { method: "POST", body: JSON.stringify({ domain: "https://www.Example.com/" }) });
  });

  it("are counted from a site's pages, and refused from anywhere else", async () => {
    const pre = await fetch(`${base}/api/event`, { method: "OPTIONS" });
    expect([pre.status, pre.headers.get("access-control-allow-origin")]).toEqual([204, "*"]);
    const ok = await send({ n: "pageview", s: "example.com", u: "https://www.example.com/" });
    expect([ok.status, await ok.json(), ok.headers.get("access-control-allow-origin")]).toEqual([202, { counted: true }, "*"]);
    expect((await send({ n: "pageview", s: "other.com", u: "https://other.com/" })).status).toBe(404);
    expect((await send({ n: "pageview", s: "example.com", u: "https://evil.com/" })).status).toBe(403);
    expect((await send({ n: "pageview", s: "example.com", u: "https://blog.example.com/" })).status).toBe(403);
    expect((await send({ n: "<script>", s: "example.com", u: "https://example.com/" })).status).toBe(400);
    expect(await (await send({ n: "pageview", s: "example.com", u: "https://example.com/" }, "Googlebot/2.1 (+http://www.google.com/bot.html)")).json()).toEqual({ counted: false, reason: "bot" });
    const sites = (await (await admin("sites")).json()) as { sites: { id: number }[] };
    await admin(`sites/${sites.sites[0]!.id}`, { method: "PATCH", body: JSON.stringify({ subdomains: true }) });
    expect((await send({ n: "pageview", s: "example.com", u: "https://blog.example.com/" })).status).toBe(202);
    app.ingest.flush();
    expect((app.db.prepare("SELECT count(*) n FROM events").get() as { n: number }).n).toBe(2);
  });

  it("build visits: 30 minutes apart is a new one; pings count toward the time; nothing is stored about the address", () => {
    const site = app.sites.byDomain("example.com")!;
    const t = Date.UTC(2026, 9, 31, 12);
    const ev = (n: string, u: string, at: number, extra: Record<string, unknown> = {}) => app.ingest.record({ n, s: "example.com", u, w: 390, ...extra }, req(IPHONE, "81.2.69.160"), at);
    ev("pageview", "https://example.com/?utm_source=newsletter&utm_campaign=launch", t, { r: "https://www.google.com/search" });
    ev("pageview", "https://example.com/pricing/", t + 60_000, { r: "https://example.com/" });
    ev("ping", "https://example.com/pricing", t + 3 * 60_000);
    ev("Signup", "https://example.com/pricing", t + 4 * 60_000, { p: { plan: "pro", nested: { no: 1 }, "bad key": "x" } });
    ev("pageview", "https://example.com/", t + 4 * 60_000 + VISIT_GAP + 1);
    app.ingest.flush();
    const visits = app.db.prepare("SELECT * FROM sessions ORDER BY started_at").all() as Record<string, unknown>[];
    expect(visits).toHaveLength(2);
    expect(visits[0]).toMatchObject({
      site_id: site.id,
      pageviews: 2,
      events: 1,
      entry: "/",
      exit: "/pricing",
      referrer: "google.com",
      utm_source: "newsletter",
      utm_campaign: "launch",
      device: "mobile",
      browser: "Safari",
      os: "iOS",
      screen: "Phone",
      started_at: t,
      ended_at: t + 4 * 60_000,
    });
    const events = app.db.prepare("SELECT name, path, props FROM events ORDER BY at").all();
    expect(events).toEqual([
      { name: "pageview", path: "/", props: null },
      { name: "pageview", path: "/pricing", props: null },
      { name: "Signup", path: "/pricing", props: '{"plan":"pro"}' },
      { name: "pageview", path: "/", props: null },
    ]);
    const dump = JSON.stringify(app.db.prepare("SELECT * FROM sessions").all()) + JSON.stringify(app.db.prepare("SELECT * FROM events").all());
    expect(dump).not.toContain("81.2.69.160");
  });

  it("are limited per address and site", () => {
    const t = Date.now();
    let refused = 0;
    for (let i = 0; i < 320; i++) {
      try {
        app.ingest.record({ n: "pageview", s: "example.com", u: `https://example.com/${i}` }, req(CHROME, "203.0.113.9"), t);
      } catch {
        refused++;
      }
    }
    expect(refused).toBe(20);
  });
});

describe("stats", () => {
  it("count visitors, visits, pageviews, bounces and time, by day and by what you filter", async () => {
    await admin("sites", { method: "POST", body: JSON.stringify({ domain: "example.com" }) });
    const site = app.sites.byDomain("example.com")!;
    const now = Date.UTC(2026, 9, 31, 15);
    const day = 86_400_000;
    const visit = (ip: string, ua: string, at: number, pages: string[], ref?: string) =>
      pages.forEach((path, i) => app.ingest.record({ n: "pageview", s: "example.com", u: `https://example.com${path}`, r: i === 0 ? ref : undefined }, req(ua, ip), at + i * 30_000));
    visit("81.2.69.1", CHROME, now - 2 * day, ["/", "/pricing", "/signup"], "https://t.co/x");
    visit("81.2.69.2", IPHONE, now - day, ["/"], "https://t.co/y");
    visit("81.2.69.3", CHROME, now - 3600_000, ["/blog/hello"]);
    visit("81.2.69.1", CHROME, now - 10 * day, ["/"]);
    app.ingest.flush();
    const s = stats(app.db, site.id, { range: "7d", now });
    expect(s.total).toEqual({ visitors: 3, visits: 3, pageviews: 5, bounceRate: 2 / 3, duration: 20_000 });
    expect(s.previous.visits).toBe(1);
    expect(s.series).toHaveLength(7);
    expect(s.series.reduce((a, p) => a + p.pageviews, 0)).toBe(5);
    expect(s.pages[0]).toEqual({ name: "/", visitors: 2, count: 2 });
    expect(s.referrers).toEqual([{ name: "t.co", visitors: 2, count: 2 }, { name: "", visitors: 1, count: 1 }]);
    expect(s.entries.map((r) => r.name).sort()).toEqual(["/", "/blog/hello"]);
    expect(s.devices).toEqual(expect.arrayContaining([{ name: "desktop", visitors: 2, count: 2 }, { name: "mobile", visitors: 1, count: 1 }]));
    const viaTco = stats(app.db, site.id, { range: "7d", now, filters: { referrer: "t.co" } });
    expect(viaTco.total.visits).toBe(2);
    const pricing = stats(app.db, site.id, { range: "7d", now, filters: { page: "/pricing" } });
    expect([pricing.total.pageviews, pricing.total.visits]).toEqual([1, 1]);
    const direct = stats(app.db, site.id, { range: "7d", now, filters: { referrer: "" } });
    expect(direct.total.visits).toBe(1);
    expect(live(app.db, site.id, now).visitors).toBe(0);
    expect(live(app.db, site.id, now - 3600_000 + 60_000)).toEqual({ visitors: 1, pages: [{ name: "/blog/hello", visitors: 1, count: 1 }] });
    expect(prune(app.db, 5, now)).toEqual({ events: 1, visits: 1 });
  });

  it("come from the admin API, which answers only on this server with the token", async () => {
    expect((await fetch(`${base}/_admin/sites`)).status).toBe(401);
    expect((await fetch(`${base}/_admin/sites`, { headers: { Authorization: `Bearer ${TOKEN}`, "X-Forwarded-For": "1.2.3.4" } })).status).toBe(404);
    const made = (await (await admin("sites", { method: "POST", body: JSON.stringify({ domain: "example.com" }) })).json()) as { id: number };
    expect((await admin("sites", { method: "POST", body: JSON.stringify({ domain: "example.com" }) })).status).toBe(409);
    await send({ n: "pageview", s: "example.com", u: "https://example.com/" });
    const list = (await (await admin("sites")).json()) as { sites: Record<string, unknown>[] };
    expect(list.sites[0]).toMatchObject({ domain: "example.com", visitors: 1, live: 1 });
    const s = (await (await admin(`stats?site=${made.id}&range=today&country=`)).json()) as Record<string, any>;
    expect(s.total.pageviews).toBe(1);
    expect((await admin(`stats?site=${made.id}&range=1y`)).status).toBe(400);
    expect((await admin(`stats?site=999`)).status).toBe(404);
    expect(await (await admin("settings", { method: "PUT", body: JSON.stringify({ keepDays: 30 }) })).json()).toEqual({ keepDays: 30 });
    expect((await admin(`sites/${made.id}`, { method: "DELETE" })).status).toBe(200);
    expect(app.db.prepare("SELECT count(*) n FROM events").get()).toEqual({ n: 0 });
  });
});

describe("parts", () => {
  it("clean paths, screens, properties and domains", () => {
    expect([cleanPath("/pricing/"), cleanPath("/"), cleanPath("")]).toEqual(["/pricing", "/", "/"]);
    expect([screenOf(375), screenOf(800), screenOf(1280), screenOf(2560), screenOf("x")]).toEqual(["Phone", "Tablet", "Laptop", "Desktop", null]);
    expect(propsOf({ a: 1, b: true, c: "x".repeat(200) })).toBe(JSON.stringify({ a: "1", b: "true", c: "x".repeat(100) }));
    expect(propsOf("nope")).toBeNull();
    expect(checkDomain("HTTPS://WWW.Example.COM/path")).toBe("example.com");
    expect(() => checkDomain("not a domain")).toThrow();
    expect(() => checkDomain("localhost")).toThrow();
  });
});

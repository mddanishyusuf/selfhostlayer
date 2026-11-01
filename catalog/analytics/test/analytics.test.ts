import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.ts";
import { addGoal, goalStats, listGoals, MAX_GOALS, removeGoal, updateGoal } from "../src/goals.ts";
import { cleanPath, propsOf, screenOf, VISIT_GAP, VISIT_ID } from "../src/ingest.ts";
import { journey, outbound, pagesTable, realtime, visitList } from "../src/reports.ts";
import { mainCurrency, revenueStats, revenueSummary } from "../src/revenue.ts";
import { SCRIPT } from "../src/script.ts";
import { checkDomain } from "../src/sites.ts";
import { live, prune, stats } from "../src/stats.ts";

const TOKEN = "a".repeat(64);
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** What the payment providers answer in a test: each request's URL, and its answer. */
let provider: (url: URL) => { status?: number; body: unknown } = () => ({ status: 404, body: { error: { message: "nothing here" } } });
let asked: URL[] = [];
const fakeFetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  asked.push(url);
  const r = provider(url);
  return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

let app: App;
let base = "";
let dataDir = "";
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "analytics-"));
  asked = [];
  app = createApp({ dataDir, token: TOKEN, releaseDir: dataDir, version: "test", flushMs: 0, providers: { fetch: fakeFetch }, syncTimer: false });
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
    const sent: { url: string; body: Record<string, unknown>; fetched?: boolean }[] = [];
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
    const location = { href: "https://example.com/pricing?utm_source=x", pathname: "/pricing", hostname: o.hostname ?? "example.com", host: o.hostname ?? "example.com", protocol: "https:" };
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
    const fetch = (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body), fetched: true });
      return Promise.resolve({ json: () => Promise.resolve({ counted: true, visit: "AbCdEfGh-_12" }) });
    };
    runInNewContext(SCRIPT, { window, document, navigator, location, history, fetch });
    return { sent, window: window as { shl: { track: (n: string, p?: unknown) => void; visit: string | null; ready: Promise<string | null> } }, history, listeners, document };
  }

  it("sends a pageview on load and on route changes, and custom events, to its own address", () => {
    const p = page();
    expect(p.sent[0]).toEqual({ url: "https://a.example.org/api/event", body: { n: "pageview", s: "example.com", u: "https://example.com/pricing?utm_source=x", r: "https://news.ycombinator.com/", w: 1280 }, fetched: true });
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
    expect(p.sent.map((s) => s.fetched === true)).toEqual([true, true, false, false]);
  });

  it("names the visit for checkouts, and counts clicks to other sites, adding the visit to payment links", async () => {
    const p = page();
    expect(await p.window.shl.ready).toBe("AbCdEfGh-_12");
    expect(p.window.shl.visit).toBe("AbCdEfGh-_12");
    const click = (a: Record<string, string>) => {
      for (const f of p.listeners.click ?? []) f({ target: { closest: () => ({ protocol: "https:", search: "", ...a }) } });
    };
    click({ host: "example.com", hostname: "example.com", origin: "https://example.com", pathname: "/docs" });
    const stripe = { protocol: "https:", host: "buy.stripe.com", hostname: "buy.stripe.com", origin: "https://buy.stripe.com", pathname: "/test_123", search: "" };
    for (const f of p.listeners.click ?? []) f({ target: { closest: () => stripe } });
    const dodo = { protocol: "https:", host: "checkout.dodopayments.com", hostname: "checkout.dodopayments.com", origin: "https://checkout.dodopayments.com", pathname: "/buy/pdt_1", search: "?quantity=1" };
    for (const f of p.listeners.click ?? []) f({ target: { closest: () => dodo } });
    const lemon = { protocol: "https:", host: "piqo.lemonsqueezy.com", hostname: "piqo.lemonsqueezy.com", origin: "https://piqo.lemonsqueezy.com", pathname: "/buy/2a0d4b1e", search: "" };
    for (const f of p.listeners.click ?? []) f({ target: { closest: () => lemon } });
    click({ host: "github.com", hostname: "github.com", origin: "https://github.com", pathname: "/x/y" });
    expect(stripe.search).toBe("client_reference_id=AbCdEfGh-_12");
    expect(dodo.search).toBe("?quantity=1&metadata_shl_visit=AbCdEfGh-_12");
    expect(lemon.search).toBe("checkout[custom][shl_visit]=AbCdEfGh-_12");
    expect(p.sent.filter((s) => s.body.n === "Outbound link").map((s) => s.body.p)).toEqual([{ url: "https://buy.stripe.com/test_123" }, { url: "https://checkout.dodopayments.com/buy/pdt_1" }, { url: "https://piqo.lemonsqueezy.com/buy/2a0d4b1e" }, { url: "https://github.com/x/y" }]);
  });

  it("sends nothing from automated browsers or localhost, where the visit is null", async () => {
    const robot = page({ webdriver: true });
    expect(robot.sent).toEqual([]);
    expect(await robot.window.shl.ready).toBeNull();
    expect(page({ hostname: "localhost" }).sent).toEqual([]);
  });

  it("is served small, cached for an hour", async () => {
    const res = await fetch(`${base}/script.js`);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect((await res.text()).length).toBeLessThan(2560);
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
    const answer = (await ok.json()) as { counted: boolean; visit: string };
    expect([ok.status, answer.counted, VISIT_ID.test(answer.visit), ok.headers.get("access-control-allow-origin")]).toEqual([202, true, true, "*"]);
    // The same visitor's next page is in the same visit.
    expect(((await (await send({ n: "pageview", s: "example.com", u: "https://example.com/pricing" })).json()) as { visit: string }).visit).toBe(answer.visit);
    expect((await send({ n: "pageview", s: "other.com", u: "https://other.com/" })).status).toBe(404);
    expect((await send({ n: "pageview", s: "example.com", u: "https://evil.com/" })).status).toBe(403);
    expect((await send({ n: "pageview", s: "example.com", u: "https://blog.example.com/" })).status).toBe(403);
    expect((await send({ n: "<script>", s: "example.com", u: "https://example.com/" })).status).toBe(400);
    expect(await (await send({ n: "pageview", s: "example.com", u: "https://example.com/" }, "Googlebot/2.1 (+http://www.google.com/bot.html)")).json()).toEqual({ counted: false, reason: "bot" });
    const sites = (await (await admin("sites")).json()) as { sites: { id: number }[] };
    await admin(`sites/${sites.sites[0]!.id}`, { method: "PATCH", body: JSON.stringify({ subdomains: true }) });
    expect((await send({ n: "pageview", s: "example.com", u: "https://blog.example.com/" })).status).toBe(202);
    app.ingest.flush();
    expect((app.db.prepare("SELECT count(*) n FROM events").get() as { n: number }).n).toBe(3);
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
    expect(propsOf({ a: 1, b: true, c: "x".repeat(300) })).toBe(JSON.stringify({ a: "1", b: "true", c: "x".repeat(200) }));
    expect(propsOf("nope")).toBeNull();
    expect(checkDomain("HTTPS://WWW.Example.COM/path")).toBe("example.com");
    expect(() => checkDomain("not a domain")).toThrow();
    expect(() => checkDomain("localhost")).toThrow();
  });
});

describe("reports", () => {
  /** One visit's pages (and events) from one address, seconds apart as given; returns the visit's id. */
  function visit(ip: string, steps: [number, string, string, Record<string, unknown>?][], at: number, ua = CHROME, ref?: string): string {
    let id = "";
    for (const [s, n, path, p] of steps) {
      const r = app.ingest.record({ n, s: "example.com", u: `https://example.com${path}`, r: ref, p }, req(ua, ip), at + s * 1000);
      id ||= r.visit ?? "";
    }
    return id;
  }

  it("list pages with entries, exits, bounces and time; visits with their journey; who's on now; links out", async () => {
    await admin("sites", { method: "POST", body: JSON.stringify({ domain: "example.com" }) });
    const site = app.sites.byDomain("example.com")!;
    const t = Date.UTC(2026, 9, 31, 12);
    const a = visit("81.2.69.1", [[0, "pageview", "/"], [30, "pageview", "/pricing"], [90, "pageview", "/signup"], [100, "Signup", "/signup", { plan: "pro" }], [120, "Outbound link", "/signup", { url: "https://github.com/x" }], [150, "ping", "/signup"]], t, CHROME, "https://news.ycombinator.com/");
    const b = visit("81.2.69.2", [[0, "pageview", "/"]], t + 600_000, IPHONE);
    visit("81.2.69.3", [[0, "pageview", "/pricing"], [60, "pageview", "/"]], t + 1_200_000);
    app.ingest.flush();
    const now = t + 1_260_000;

    const pages = pagesTable(app.db, site.id, { range: "today", now });
    expect(pages.find((p) => p.path === "/")).toEqual({ path: "/", visitors: 3, pageviews: 3, entries: 2, exits: 2, bounceRate: 0.5, time: 10_000 });
    expect(pages.find((p) => p.path === "/signup")).toMatchObject({ visitors: 1, entries: 0, exits: 1, time: 60_000 });
    expect(pagesTable(app.db, site.id, { range: "today", now, q: "PRIC" }).map((p) => p.path)).toEqual(["/pricing"]);

    expect(visitList(app.db, site.id, { range: "today", now }).visits.map((v) => v.id)[1]).toBe(b);
    expect(visitList(app.db, site.id, { range: "today", now, q: "signup" }).visits.map((v) => v.id)).toEqual([a]);
    const goal = addGoal(app.db, site.id, { kind: "page", value: "/sign*" });
    expect(visitList(app.db, site.id, { range: "today", now, goal }).total).toBe(1);
    expect(visitList(app.db, site.id, { range: "today", now, filters: { referrer: "news.ycombinator.com" } }).visits[0]).toMatchObject({ id: a, entry: "/", exit: "/signup", pageviews: 3, events: 2, payments: 0, revenue: 0 });

    const j = journey(app.db, site.id, a)!;
    expect(j.steps.map((s) => [s.name, s.path])).toEqual([
      ["pageview", "/"],
      ["pageview", "/pricing"],
      ["pageview", "/signup"],
      ["Signup", "/signup"],
      ["Outbound link", "/signup"],
    ]);
    expect(j.steps[4]!.props).toEqual({ url: "https://github.com/x" });
    expect(journey(app.db, site.id, "nope-nope-12")).toBeNull();

    const r = realtime(app.db, site.id, now);
    expect([r.visitors, r.minutes.length, r.pages]).toEqual([1, 30, [{ name: "/", visitors: 1, count: 1 }]]);
    expect(r.latest[0]).toMatchObject({ name: "pageview", path: "/", device: "desktop" });
    expect(outbound(app.db, site.id, { range: "today", now })).toEqual([{ url: "https://github.com/x", visitors: 1, clicks: 1 }]);

    // Through the admin API.
    const res = (await (await admin(`visits/${a}?site=${site.id}`)).json()) as { steps: unknown[] };
    expect(res.steps).toHaveLength(5);
    expect((await admin(`visits/${"x".repeat(12)}?site=${site.id}`)).status).toBe(404);
    expect((await admin(`visits/..%2F..?site=${site.id}`)).status).toBe(404);
    // The admin API counts by the real clock, not the test's day: a pageview now, for its today.
    visit("81.2.69.4", [[0, "pageview", "/now"]], Date.now());
    app.ingest.flush();
    expect(((await (await admin(`pages?site=${site.id}&range=today`)).json()) as { pages: { path: string }[] }).pages.map((p) => p.path)).toContain("/now");
  });
});

describe("goals", () => {
  it("are a page (with *) or an event, checked, with conversions and their share of visitors", async () => {
    await admin("sites", { method: "POST", body: JSON.stringify({ domain: "example.com" }) });
    const site = app.sites.byDomain("example.com")!;
    expect(() => addGoal(app.db, site.id, { kind: "page", value: "pricing" })).toThrow(/path/);
    expect(() => addGoal(app.db, site.id, { kind: "event", value: "<b>" })).toThrow(/event/);
    expect(() => addGoal(app.db, site.id, { kind: "form", value: "/" })).toThrow(/page or event/);
    const blog = addGoal(app.db, site.id, { name: "Read the blog", kind: "page", value: "/blog/*" });
    const signup = addGoal(app.db, site.id, { kind: "event", value: "Signup" });
    expect(signup.name).toBe("Signup");
    const t = Date.now() - 60_000;
    const ev = (ip: string, n: string, path: string) => app.ingest.record({ n, s: "example.com", u: `https://example.com${path}` }, req(CHROME, ip), t);
    ev("81.2.69.1", "pageview", "/blog/hello");
    ev("81.2.69.2", "pageview", "/blog");
    ev("81.2.69.3", "pageview", "/");
    ev("81.2.69.3", "Signup", "/");
    ev("81.2.69.4", "pageview", "/b[l]og/x");
    app.ingest.flush();
    const s = goalStats(app.db, site.id, { range: "today" });
    expect(s.map((g) => [g.name, g.visitors, g.rate])).toEqual([
      ["Read the blog", 1, 0.25],
      ["Signup", 1, 0.25],
    ]);
    expect(updateGoal(app.db, blog.id, { value: "/b[l]og/*" }).value).toBe("/b[l]og/*");
    expect(goalStats(app.db, site.id, { range: "today" })[0]!.visitors).toBe(1);
    removeGoal(app.db, signup.id);
    expect(listGoals(app.db, site.id).map((g) => g.id)).toEqual([blog.id]);
    for (let i = 1; i < MAX_GOALS; i++) addGoal(app.db, site.id, { kind: "event", value: `E${i}` });
    expect(() => addGoal(app.db, site.id, { kind: "event", value: "One more" })).toThrow(/up to/);
    // And through the admin API.
    const made = await admin("goals", { method: "POST", body: JSON.stringify({ site: site.id, kind: "page", value: "/" }) });
    expect(made.status).toBe(409);
    expect((await admin(`goals/${blog.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await admin(`goals/${blog.id}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("revenue", () => {
  const STRIPE_KEY = `rk_test_${"s".repeat(24)}abcd`;
  let visits: Record<"a" | "b" | "c" | "other", string>;
  let siteId = 0;
  const T = () => Math.floor((Date.now() - 3_600_000) / 1000);

  beforeEach(async () => {
    await admin("sites", { method: "POST", body: JSON.stringify({ domain: "example.com" }) });
    await admin("sites", { method: "POST", body: JSON.stringify({ domain: "other.com" }) });
    siteId = app.sites.byDomain("example.com")!.id;
    const at = Date.now() - 2 * 3_600_000;
    const hit = (site: string, ip: string, path: string, ref?: string) => app.ingest.record({ n: "pageview", s: site, u: `https://${site}${path}`, r: ref }, req(CHROME, ip), at).visit!;
    visits = {
      a: hit("example.com", "81.2.69.1", "/pricing", "https://news.ycombinator.com/"),
      b: hit("example.com", "81.2.69.2", "/", "https://t.co/x"),
      c: hit("example.com", "81.2.69.3", "/blog/launch"),
      other: hit("other.com", "81.2.69.4", "/"),
    };
  });

  /** Stripe's API, as much as Analytics reads: two pages of checkouts, and invoices. */
  function stripeApi(url: URL) {
    if (url.searchParams.get("limit") === "1") return { body: { data: [], has_more: false } };
    const t = T();
    if (url.pathname === "/v1/checkout/sessions" && !url.searchParams.get("starting_after")) {
      return {
        body: {
          has_more: true,
          data: [
            { id: "cs_1", payment_status: "paid", mode: "payment", amount_total: 2400, total_details: { amount_tax: 400 }, currency: "usd", customer: "cus_1", metadata: { shl_visit: visits.a }, created: t },
            { id: "cs_2", payment_status: "paid", mode: "subscription", amount_total: 1000, currency: "usd", customer: "cus_2", client_reference_id: visits.b, created: t },
          ],
        },
      };
    }
    if (url.pathname === "/v1/checkout/sessions") {
      expect(url.searchParams.get("starting_after")).toBe("cs_2");
      return {
        body: {
          has_more: false,
          data: [
            { id: "cs_3", payment_status: "no_payment_required", mode: "subscription", amount_total: 0, currency: "usd", customer: "cus_3", metadata: { shl_visit: visits.c }, created: t },
            { id: "cs_4", payment_status: "unpaid", mode: "payment", amount_total: 900, currency: "usd", customer: "cus_4", created: t },
            { id: "cs_5", payment_status: "paid", mode: "payment", amount_total: 5000, currency: "eur", customer: "cus_5", currency_conversion: { source_currency: "usd", fx_rate: "0.5" }, created: t },
            { id: "cs_6", payment_status: "paid", mode: "payment", amount_total: 700, currency: "usd", customer: "cus_6", metadata: { shl_visit: visits.other }, created: t },
            { id: "cs_7", payment_status: "paid", mode: "payment", amount_total: 3000, currency: "gbp", customer: "cus_7", created: t },
          ],
        },
      };
    }
    if (url.pathname === "/v1/invoices") {
      return {
        body: {
          has_more: false,
          data: [
            { id: "in_1", billing_reason: "subscription_create", subscription: "sub_2", amount_paid: 1000, currency: "usd", customer: "cus_2", created: t },
            { id: "in_2", billing_reason: "subscription_cycle", parent: { subscription_details: { subscription: "sub_2", metadata: {} } }, amount_paid: 1000, total_taxes: [{ amount: 100 }], currency: "usd", customer: "cus_2", status_transitions: { paid_at: t + 60 }, created: t },
            { id: "in_3", billing_reason: "subscription_cycle", subscription: "sub_3", amount_paid: 2000, tax: 0, currency: "usd", customer: "cus_3", created: t },
            { id: "in_4", billing_reason: "manual", amount_paid: 999, currency: "usd", customer: "cus_9", created: t },
          ],
        },
      };
    }
    return { status: 404, body: { error: { message: "Unrecognized request URL" } } };
  }

  it("from Stripe: checkouts and renewals, credited to the visit or the customer's first, without tax, keys encrypted", async () => {
    provider = stripeApi;
    // A publishable key can't read payments.
    await expect(app.revenue.setSource(siteId, { provider: "stripe", key: `pk_live_${"x".repeat(24)}` })).rejects.toThrow(/restricted key/);
    const source = await app.revenue.setSource(siteId, { provider: "stripe", key: STRIPE_KEY });
    expect(source).toMatchObject({ provider: "stripe", mode: "test", keyHint: "abcd" });
    expect(await app.revenue.sync(siteId, "stripe")).toEqual({ provider: "stripe", added: 7 });
    expect(asked.every((u) => u.origin === "https://api.stripe.com")).toBe(true);
    const rows = app.db.prepare("SELECT external_id id, amount, currency, visit, renewal FROM payments ORDER BY external_id").all();
    expect(rows).toEqual([
      { id: "cs_1", amount: 2000, currency: "usd", visit: visits.a, renewal: 0 },
      { id: "cs_2", amount: 1000, currency: "usd", visit: visits.b, renewal: 0 },
      { id: "cs_5", amount: 10000, currency: "usd", visit: null, renewal: 0 },
      // Another site's visit isn't this site's to credit.
      { id: "cs_6", amount: 700, currency: "usd", visit: null, renewal: 0 },
      { id: "cs_7", amount: 3000, currency: "gbp", visit: null, renewal: 0 },
      { id: "in_2", amount: 900, currency: "usd", visit: visits.b, renewal: 1 },
      // The free trial's checkout tied cus_3 to its visit.
      { id: "in_3", amount: 2000, currency: "usd", visit: visits.c, renewal: 1 },
    ]);
    expect(JSON.stringify(app.db.prepare("SELECT * FROM revenue_sources").all())).not.toContain(STRIPE_KEY.slice(8, 20));
    // Again: nothing new, and the cursor moved.
    expect((await app.revenue.sync(siteId, "stripe")).added).toBe(0);
    expect(app.revenue.sources(siteId)[0]).toMatchObject({ payments: 7, error: null, syncing: false });

    expect(mainCurrency(app.db, siteId)).toBe("usd");
    const r = revenueStats(app.db, siteId, { range: "today" });
    expect(r.total).toEqual({ amount: 16600, payments: 6, customers: 5, attributed: 5900, renewals: 2900 });
    expect(r.others).toEqual([{ currency: "gbp", amount: 3000, payments: 1 }]);
    expect(r.referrers).toEqual([
      { name: "", amount: 2000, payments: 1, customers: 1, visitors: 1 },
      { name: "news.ycombinator.com", amount: 2000, payments: 1, customers: 1, visitors: 1 },
      { name: "t.co", amount: 1900, payments: 2, customers: 1, visitors: 1 },
    ]);
    expect(r.latest).toHaveLength(7);
    expect(revenueStats(app.db, siteId, { range: "today", filters: { referrer: "t.co" } }).total.amount).toBe(1900);
    expect(revenueSummary(app.db, siteId, { range: "today" })!.total.amount).toBe(16600);
    expect(journey(app.db, siteId, visits.b)!.payments.map((p) => p.id)).toEqual(["cs_2", "in_2"]);
    expect(visitList(app.db, siteId, { range: "today", paid: true }).visits.map((v) => [v.id, v.revenue]).sort()).toEqual(
      [
        [visits.a, 2000],
        [visits.b, 1900],
        [visits.c, 2000],
      ].sort(),
    );
    const goal = addGoal(app.db, siteId, { kind: "page", value: "/" });
    expect(goalStats(app.db, siteId, { range: "today" }).find((g) => g.id === goal.id)!.revenue).toBe(1900);

    // A visit that brought a payment outlives the keep window.
    app.db.prepare("UPDATE sessions SET started_at = 0").run();
    prune(app.db, 1);
    expect(app.db.prepare("SELECT count(*) n FROM sessions").get()).toEqual({ n: 3 });

    app.revenue.removeSource(siteId, "stripe");
    expect(app.db.prepare("SELECT count(*) n FROM payments").get()).toEqual({ n: 0 });
  });

  it("says why a key or a sync fails", async () => {
    provider = () => ({ status: 401, body: { error: { message: "Invalid API Key provided: rk_test_****abcd" } } });
    await expect(app.revenue.setSource(siteId, { provider: "stripe", key: STRIPE_KEY })).rejects.toThrow("Stripe answered 401: Invalid API Key provided");
    provider = (url) => (url.searchParams.get("limit") === "1" ? { body: { data: [] } } : { status: 500, body: { error: { message: "down for a bit" } } });
    await app.revenue.setSource(siteId, { provider: "stripe", key: STRIPE_KEY });
    expect(await app.revenue.sync(siteId, "stripe")).toEqual({ provider: "stripe", added: 0, error: "Stripe answered 500: down for a bit" });
    expect(app.revenue.sources(siteId)[0]).toMatchObject({ error: "Stripe answered 500: down for a bit", syncedAt: null });
    const res = await admin("sources", { method: "PUT", body: JSON.stringify({ site: siteId, provider: "polar", key: "short" }) });
    expect([res.status, ((await res.json()) as { field: string }).field]).toEqual([400, "key"]);
  });

  it("from Paddle: completed transactions in pages of 30, renewals by their origin, the visit from custom_data", async () => {
    const iso = new Date(Date.now() - 3_600_000).toISOString();
    const txn = (n: number, more: Record<string, unknown> = {}) => ({ id: `txn_${n}`, status: "completed", customer_id: `ctm_${n % 3}`, origin: "web", currency_code: "USD", billed_at: iso, created_at: iso, custom_data: null, details: { totals: { subtotal: "1000", tax: "200", total: "1200", currency_code: "USD" } }, ...more });
    provider = (url) => {
      if (url.host !== "sandbox-api.paddle.com" || url.pathname !== "/transactions") return { status: 404, body: { error: { detail: "not found" } } };
      if (url.searchParams.get("per_page") === "1") return { body: { data: [], meta: { pagination: { per_page: 1, next: "", has_more: false } } } };
      expect([url.searchParams.get("status"), url.searchParams.get("order_by")]).toEqual(["completed", "billed_at[ASC]"]);
      if (!url.searchParams.get("after")) {
        const page = Array.from({ length: 30 }, (_, i) => txn(i + 1, i === 0 ? { custom_data: { shl_visit: visits.a } } : i === 1 ? { origin: "subscription_recurring", customer_id: "ctm_a" } : {}));
        return { body: { data: page, meta: { pagination: { per_page: 30, next: "https://sandbox-api.paddle.com/transactions?after=txn_30", has_more: true } } } };
      }
      expect(url.searchParams.get("after")).toBe("txn_30");
      return { body: { data: [txn(31, { custom_data: { shl_visit: visits.b }, customer_id: "ctm_b" })], meta: { pagination: { per_page: 30, next: "https://sandbox-api.paddle.com/transactions?after=txn_31", has_more: false } } } };
    };
    // A sandbox key says so; a bare key would take the mode chosen.
    const half = await admin("sources", { method: "PUT", body: JSON.stringify({ site: siteId, provider: "paddle", key: `pdl_live_apikey_${"p".repeat(20)}` }) });
    expect([half.status, ((await half.json()) as { field: string }).field]).toEqual([400, "key"]);
    const src = await (await admin("sources", { method: "PUT", body: JSON.stringify({ site: siteId, provider: "paddle", key: "pdl_sdbx_apikey_01jabcdefghijklmnopqrstuvw_AbCdEfGhIjKlMnOpQrStUv_x9z" }) })).json();
    expect(src).toMatchObject({ provider: "paddle", mode: "test" });
    // Connecting pulled them already; another sync finds nothing new.
    await app.revenue.sync(siteId, "paddle");
    expect(app.db.prepare("SELECT count(*) n FROM payments WHERE provider = 'paddle'").get()).toEqual({ n: 31 });
    expect(await app.revenue.sync(siteId, "paddle")).toEqual({ provider: "paddle", added: 0 });
    const rows = app.db.prepare("SELECT external_id id, amount, currency, visit, renewal FROM payments WHERE provider = 'paddle' AND external_id IN ('txn_1', 'txn_2', 'txn_31') ORDER BY external_id").all();
    expect(rows).toEqual([
      { id: "txn_1", amount: 1000, currency: "usd", visit: visits.a, renewal: 0 },
      { id: "txn_2", amount: 1000, currency: "usd", visit: null, renewal: 1 },
      { id: "txn_31", amount: 1000, currency: "usd", visit: visits.b, renewal: 0 },
    ]);
  });

  /** A webhook as the provider sends it: the raw body, signed with the secret (or not). */
  const hook = (provider: string, body: unknown, secret: string) => {
    const raw = JSON.stringify(body);
    const header = provider === "creem" ? "creem-signature" : "X-Signature";
    return fetch(`${base}/webhooks/${provider}/${siteId}`, { method: "POST", body: raw, headers: { "Content-Type": "application/json", [header]: createHmac("sha256", secret).update(raw).digest("hex") } });
  };

  it("from Lemon Squeezy, by webhook: orders, and later subscription payments (not the first), live only, signed", async () => {
    const secret = "ls-secret-0123456789";
    expect((await admin("sources", { method: "PUT", body: JSON.stringify({ site: siteId, provider: "lemonsqueezy", key: secret }) })).status).toBe(200);
    expect(asked).toEqual([]);
    const at = new Date(Date.now() - 3_600_000).toISOString();
    const order = (id: string, more: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({ meta: { event_name: "order_created", custom_data: { shl_visit: visits.a }, ...meta }, data: { type: "orders", id, attributes: { status: "paid", currency: "EUR", subtotal: 1000, tax: 210, total: 1210, customer_id: 77, test_mode: false, created_at: at, ...more } } });
    expect(await (await hook("lemonsqueezy", order("1"), secret)).json()).toEqual({ received: true, added: 1 });
    expect((await hook("lemonsqueezy", order("1"), secret)).status).toBe(200);
    expect((await hook("lemonsqueezy", order("2"), "another-secret")).status).toBe(401);
    expect((await hook("lemonsqueezy", order("3", { test_mode: true }), secret)).status).toBe(200);
    const invoice = (id: string, reason: string) => ({ meta: { event_name: "subscription_payment_success", custom_data: {} }, data: { type: "subscription-invoices", id, attributes: { status: "paid", billing_reason: reason, currency: "EUR", subtotal: 1000, tax: 210, total: 1210, customer_id: 77, test_mode: false, created_at: at } } });
    await hook("lemonsqueezy", invoice("50", "initial"), secret);
    await hook("lemonsqueezy", invoice("51", "renewal"), secret);
    expect((await fetch(`${base}/webhooks/lemonsqueezy/${siteId + 99}`, { method: "POST", body: "{}" })).status).toBe(404);
    expect(app.db.prepare("SELECT external_id id, amount, currency, visit, renewal FROM payments WHERE provider = 'lemonsqueezy' ORDER BY external_id").all()).toEqual([
      { id: "invoice:51", amount: 1000, currency: "eur", visit: visits.a, renewal: 1 },
      { id: "order:1", amount: 1000, currency: "eur", visit: visits.a, renewal: 0 },
    ]);
    const s = (await (await admin(`sources?site=${siteId}`)).json()).sources[0];
    expect(s).toMatchObject({ provider: "lemonsqueezy", payments: 2, error: null });
    expect(s.syncedAt).toBeGreaterThan(0);
  });

  it("from Creem, by webhook: a checkout and its subscription's payments, the first kept once", async () => {
    const secret = "whsec_creem0123456789";
    await admin("sources", { method: "PUT", body: JSON.stringify({ site: siteId, provider: "creem", key: secret }) });
    const now = Date.now() - 3_600_000;
    const checkout = { id: "evt_1", eventType: "checkout.completed", created_at: now, object: { object: "checkout", mode: "prod", metadata: { shl_visit: visits.c }, customer: { id: "cust_1" }, order: { id: "ord_1", customer: "cust_1", amount: 1000, currency: "USD", tax_amount: 100, amount_paid: 1100, status: "paid", type: "recurring", transaction: "tran_1", created_at: new Date(now).toISOString() } } };
    const paid = (id: string) => ({ id: `evt_${id}`, eventType: "subscription.paid", created_at: now, object: { object: "subscription", mode: "prod", customer: { id: "cust_1" }, metadata: {}, last_transaction: { id, amount: 1000, amount_paid: 1100, currency: "USD", tax_amount: 100, status: "paid", created_at: now } } });
    // Another signature is refused and changes nothing on the source (anyone can send one).
    const errorOf = async () => (await (await admin(`sources?site=${siteId}`)).json()).sources[0].error;
    expect((await hook("creem", paid("tran_0"), "whsec_pasted_wrong")).status).toBe(401);
    expect(await errorOf()).toBeNull();
    // Nothing is read for a provider that sends no webhooks, or a site without the provider.
    expect((await fetch(`${base}/webhooks/stripe/${siteId}`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(`${base}/webhooks/creem/${siteId + 5}`, { method: "POST", body: "{}" })).status).toBe(404);
    // The first payment comes as a subscription payment too, maybe before its checkout.
    await hook("creem", paid("tran_1"), secret);
    await hook("creem", checkout, secret);
    await hook("creem", paid("tran_1"), secret);
    await hook("creem", paid("tran_2"), secret);
    await hook("creem", { ...checkout, object: { ...checkout.object, mode: "test", order: { ...checkout.object.order, transaction: "tran_9" } } }, secret);
    expect(app.db.prepare("SELECT external_id id, amount, currency, visit, renewal FROM payments WHERE provider = 'creem' ORDER BY external_id").all()).toEqual([
      { id: "tran_1", amount: 1000, currency: "usd", visit: visits.c, renewal: 0 },
      { id: "tran_2", amount: 1000, currency: "usd", visit: visits.c, renewal: 1 },
    ]);
    expect((await (await admin("sync", { method: "POST", body: JSON.stringify({ site: siteId }) })).json()).results).toEqual([{ provider: "creem", added: 0 }]);
  });

  it("from Polar (sandbox) and Dodo Payments (each new payment read once, in the account's currency)", async () => {
    const iso = new Date(Date.now() - 3_600_000).toISOString();
    let details = 0;
    provider = (url) => {
      if (url.host === "sandbox-api.polar.sh") {
        return {
          body: {
            items: url.searchParams.get("limit") === "1" ? [] : [
              { id: "o1", paid: true, status: "paid", net_amount: 1500, total_amount: 1800, tax_amount: 300, currency: "usd", billing_reason: "purchase", customer_id: "pc1", metadata: { shl_visit: visits.a }, created_at: iso },
              { id: "o2", paid: false, status: "pending", net_amount: 1500, currency: "usd", billing_reason: "purchase", customer_id: "pc2", metadata: {}, created_at: iso },
              { id: "o3", paid: true, status: "paid", net_amount: 1500, currency: "usd", billing_reason: "subscription_cycle", customer_id: "pc1", metadata: {}, created_at: iso },
            ],
            pagination: { total_count: 3, max_page: 1 },
          },
        };
      }
      if (url.host === "live.dodopayments.com" && url.pathname === "/payments") {
        return { body: { items: url.searchParams.get("page_size") === "1" ? [] : [{ payment_id: "pay_1", total_amount: 1180, currency: "INR", created_at: iso, metadata: { shl_visit: visits.c }, customer: { customer_id: "dc1", email: "x@example.com", name: "X" }, charge_type: null }] } };
      }
      if (url.host === "live.dodopayments.com" && url.pathname === "/payments/pay_1") {
        details++;
        return { body: { payment_id: "pay_1", total_amount: 1180, tax: 180, currency: "INR", settlement_amount: 14, settlement_tax: 2, settlement_currency: "USD", created_at: iso, metadata: { shl_visit: visits.c }, customer: { customer_id: "dc1" }, charge_type: null } };
      }
      return { status: 404, body: { detail: "Not found" } };
    };
    await app.revenue.setSource(siteId, { provider: "polar", key: "polar_oat_0123456789abcdef", mode: "test" });
    expect(await app.revenue.sync(siteId, "polar")).toEqual({ provider: "polar", added: 2 });
    await app.revenue.setSource(siteId, { provider: "dodo", key: "dodo_live_0123456789abcdef" });
    expect(await app.revenue.sync(siteId, "dodo")).toEqual({ provider: "dodo", added: 1 });
    expect((await app.revenue.sync(siteId, "dodo")).added).toBe(0);
    expect(details).toBe(1);
    expect(app.db.prepare("SELECT provider, external_id id, amount, currency, visit, renewal FROM payments ORDER BY provider, external_id").all()).toEqual([
      { provider: "dodo", id: "pay_1", amount: 12, currency: "usd", visit: visits.c, renewal: 0 },
      { provider: "polar", id: "o1", amount: 1500, currency: "usd", visit: visits.a, renewal: 0 },
      { provider: "polar", id: "o3", amount: 1500, currency: "usd", visit: visits.a, renewal: 1 },
    ]);
    const res = (await (await admin(`revenue?site=${siteId}&range=today`)).json()) as { total: { amount: number }; sources: { provider: string }[] };
    expect([res.total.amount, res.sources.map((s) => s.provider)]).toEqual([3012, ["polar", "dodo"]]);
    const synced = (await (await admin("sync", { method: "POST", body: JSON.stringify({ site: siteId }) })).json()) as { results: { added: number }[] };
    expect(synced.results.map((r) => r.added)).toEqual([0, 0]);
    expect((await admin(`sources?site=${siteId}&provider=polar`, { method: "DELETE" })).status).toBe(200);
    expect((await admin(`sources?site=${siteId}&provider=polar`, { method: "DELETE" })).status).toBe(404);
  });
});

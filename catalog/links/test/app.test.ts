import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, NewerDatabaseError, openDb } from "../src/db.ts";
import { rollup } from "../src/stats.ts";
import { BROWSER, cleanup, start, TOKEN, type Running } from "./helpers.ts";

let links: Running;
beforeEach(async () => {
  links = await start();
});
afterEach(async () => {
  await links.stop();
  cleanup(links.dataDir);
});

const visit = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  fetch(`${links.base}${path}`, { redirect: "manual", ...init, headers: { "User-Agent": BROWSER, ...headers } });
const create = async (body: Record<string, unknown>) => {
  const res = await links.admin("links", { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("redirects", () => {
  it("sends a click on, with the visitor's query string (the target's own parameters kept), whatever the case of the slug", async () => {
    await create({ slug: "Launch", target: "https://example.com/post?ref=links" });
    const res = await visit("/LAUNCH?utm_source=x&ref=mine");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/post?ref=links&utm_source=x");
    expect(res.headers.get("cache-control")).toBe("no-store");
    await create({ slug: "plain", target: "https://example.com/", passQuery: false, redirect: 301 });
    const plain = await visit("/plain?x=1");
    expect([plain.status, plain.headers.get("location"), plain.headers.get("cache-control")]).toEqual([301, "https://example.com/", "public, max-age=86400"]);
  });

  it("answers unknown, turned-off and expired links, the bare domain and the browser's icon", async () => {
    await create({ slug: "off", target: "https://example.com/", disabled: true });
    await create({ slug: "old", target: "https://example.com/", expiresAt: Date.now() - 1000 });
    expect((await visit("/nope")).status).toBe(404);
    expect((await visit("/off")).status).toBe(410);
    expect((await visit("/old")).status).toBe(410);
    expect((await visit("/")).status).toBe(200);
    expect((await visit("/favicon.ico")).status).toBe(204);
    expect(await (await visit("/robots.txt")).text()).toContain("Disallow: /");
    await links.admin("settings", { method: "PUT", body: JSON.stringify({ home: "https://example.com/home", missing: "https://example.com/404" }) });
    expect((await visit("/")).headers.get("location")).toBe("https://example.com/home");
    expect((await visit("/nope")).headers.get("location")).toBe("https://example.com/404");
  });

  it("counts clicks off the redirect path: browsers, not bots or HEAD; no address stored", async () => {
    const { body: link } = await create({ slug: "c", target: "https://example.com/" });
    await visit("/c", { Referer: "https://news.ycombinator.com/", "X-Forwarded-For": "81.2.69.160" });
    await visit("/c", { "User-Agent": "Slackbot-LinkExpanding 1.0" });
    await visit("/c", {}, { method: "HEAD" });
    expect(links.app.clicks.pending).toBe(2);
    links.app.clicks.flush();
    const rows = links.app.db.prepare("SELECT * FROM clicks").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ link_id: link.id, referrer: "news.ycombinator.com", device: "desktop", browser: "Chrome", os: "macOS", bot: 0 });
    expect(rows[1]).toMatchObject({ bot: 1 });
    expect(JSON.stringify(rows)).not.toContain("81.2.69.160");
    expect(links.app.store.bySlug("c")!.clicks).toBe(1);
  });

  it("asks for a link's password, and remembers a correct one for that link only", async () => {
    await create({ slug: "secret", target: "https://example.com/secret", password: "hunter2" });
    const form = await visit("/secret");
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('type="password"');
    const post = (password: string) => visit("/secret", { "Content-Type": "application/x-www-form-urlencoded" }, { method: "POST", body: `password=${password}` });
    expect((await post("wrong")).status).toBe(403);
    const ok = await post("hunter2");
    expect([ok.status, ok.headers.get("location")]).toEqual([303, "https://example.com/secret"]);
    const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
    expect(ok.headers.get("set-cookie")).toContain("Path=/secret");
    const again = await visit("/secret", { Cookie: cookie });
    expect(again.headers.get("location")).toBe("https://example.com/secret");
    // A new password locks browsers out again.
    await links.admin(`links/${links.app.store.bySlug("secret")!.id}`, { method: "PATCH", body: JSON.stringify({ password: "new-one" }) });
    expect((await visit("/secret", { Cookie: cookie })).status).toBe(200);
  });
});

describe("the admin API", () => {
  it("answers only on this server with the token, never through Caddy", async () => {
    expect((await fetch(`${links.base}/_admin/info`)).status).toBe(401);
    expect((await fetch(`${links.base}/_admin/info`, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${links.base}/_admin/info`, { headers: { Authorization: `Bearer ${TOKEN}`, "X-Forwarded-For": "1.2.3.4" } })).status).toBe(404);
    expect(await (await links.admin("info")).json()).toMatchObject({ version: "test", links: 0 });
  });

  it("creates, lists, edits and deletes links, and says what's wrong", async () => {
    const made = await create({ target: "https://example.com/a", title: "A", tags: "x, y" });
    expect(made.status).toBe(201);
    expect(made.body.slug).toMatch(/^[2-9a-hjkmnp-z]{7}$/);
    expect(made.body).not.toHaveProperty("passwordHash");
    expect(await create({ slug: made.body.slug, target: "https://example.com/b" })).toMatchObject({ status: 409, body: { field: "slug" } });
    expect(await create({ target: "http://10.0.0.1" })).toMatchObject({ status: 400, body: { field: "target", error: "can't point at a private address" } });
    await create({ slug: "second", target: "https://example.com/b", tags: ["y"] });
    const list = (await (await links.admin("links?tag=y&sort=slug")).json()) as { links: { slug: string }[]; total: number; tags: unknown[] };
    expect(list.links.map((l) => l.slug)).toEqual([made.body.slug, "second"].sort());
    expect(list.tags).toEqual([{ tag: "y", links: 2 }, { tag: "x", links: 1 }]);
    const edited = await links.admin(`links/${made.body.id}`, { method: "PATCH", body: JSON.stringify({ slug: "Renamed", disabled: true }) });
    expect(await edited.json()).toMatchObject({ slug: "renamed", disabled: true, title: "A" });
    expect(links.app.store.bySlug(made.body.slug)).toBeUndefined();
    expect((await links.admin(`links/${made.body.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await links.admin(`links/${made.body.id}`)).status).toBe(404);
  });

  it("gives stats by hour or day: totals, top links, referrers, countries and devices, bots apart", async () => {
    const { body: a } = await create({ slug: "a", target: "https://example.com/a" });
    await create({ slug: "b", target: "https://example.com/b" });
    for (const ip of ["81.2.69.1", "81.2.69.2", "81.2.69.2"]) await visit("/a", { "X-Forwarded-For": ip, Referer: "https://t.co/x" });
    await visit("/b");
    await visit("/a", { "User-Agent": "curl/8" });
    const s = (await (await links.admin("stats?range=24h")).json()) as Record<string, any>;
    expect(s.total).toEqual({ clicks: 4, visitors: 3, bots: 1 });
    expect(s.series).toHaveLength(24);
    expect(s.series.at(-1).clicks).toBe(4);
    expect(s.links).toEqual([{ id: a.id, slug: "a", clicks: 3 }, expect.objectContaining({ slug: "b", clicks: 1 })]);
    expect(s.referrers).toEqual([{ name: "t.co", clicks: 3 }, { name: "", clicks: 1 }]);
    const one = (await (await links.admin(`stats?range=7d&link=${a.id}&bots=1`)).json()) as Record<string, any>;
    expect(one.total.clicks).toBe(4);
    expect(one.series).toHaveLength(7);
    expect((await links.admin("stats?range=1y")).status).toBe(400);
  });

  it("makes API tokens shown once, and the public API takes them until revoked", async () => {
    const made = (await (await links.admin("tokens", { method: "POST", body: JSON.stringify({ name: "zapier" }) })).json()) as { id: number; token: string };
    expect(made.token).toMatch(/^lk_/);
    const listed = (await (await links.admin("tokens")).json()) as { tokens: Record<string, unknown>[] };
    expect(JSON.stringify(listed)).not.toContain(made.token);
    const api = (path: string, init: RequestInit = {}, token = made.token) =>
      fetch(`${links.base}/api/v1/links${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.5" } });
    const created = await api("", { method: "POST", body: JSON.stringify({ slug: "api", target: "https://example.com/" }) });
    expect(created.status).toBe(400);
    const ok = await api("", { method: "POST", body: JSON.stringify({ slug: "from-api", target: "https://example.com/" }) });
    // The short URL is on the domain the request came to (fetch can't set Host, so here it's this test server's).
    expect(await ok.json()).toMatchObject({ slug: "from-api", shortUrl: `https://${new URL(links.base).host}/from-api` });
    expect(await (await api("/FROM-API", { method: "PATCH", body: JSON.stringify({ title: "Hi" }) })).json()).toMatchObject({ title: "Hi" });
    expect(((await (await api("?q=from")).json()) as { total: number }).total).toBe(1);
    expect((await api("", {}, "lk_wrong")).status).toBe(401);
    await links.admin(`tokens/${made.id}`, { method: "DELETE" });
    expect((await api("")).status).toBe(401);
  });

  it("exports and imports CSV", async () => {
    await create({ slug: "one", target: "https://example.com/1", tags: ["a"] });
    const csv = await (await links.admin("export")).text();
    expect(csv.split("\n")[1]).toMatch(/^one,https:\/\/example.com\/1,,a,302,true,,false,0,/);
    const r = await links.admin("import", { method: "POST", body: "url,slug\nhttps://example.com/2,two\nhttps://example.com/1,one\n", headers: { "Content-Type": "text/csv" } });
    expect(await r.json()).toEqual({ created: 1, skipped: [{ line: 3, reason: "slug: one is taken" }] });
  });
});

describe("data", () => {
  it("rolls raw clicks past the keep window into daily totals that stats still count", async () => {
    const { body: a } = await create({ slug: "a", target: "https://example.com/a" });
    const day = 86_400_000;
    const now = Date.now();
    const insert = links.app.db.prepare("INSERT INTO clicks (link_id, at, referrer, country, device, browser, os, bot, visitor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run(a.id, now - 3 * day, "t.co", "GB", "mobile", "Safari", "iOS", 0, "v1");
    insert.run(a.id, now - 3 * day, null, "GB", "desktop", "Chrome", "macOS", 0, "v2");
    insert.run(a.id, now - 3 * day, null, null, "other", "Other", "Other", 1, "v3");
    insert.run(a.id, now, null, "US", "desktop", "Chrome", "macOS", 0, "v4");
    expect(rollup(links.app.db, 2, now)).toEqual({ days: 1, clicks: 3 });
    expect(links.app.db.prepare("SELECT count(*) n FROM clicks").get()).toEqual({ n: 1 });
    const s = (await (await links.admin("stats?range=7d")).json()) as Record<string, any>;
    expect(s.total).toEqual({ clicks: 3, visitors: 3, bots: 1 });
    expect(s.countries).toEqual([{ name: "GB", clicks: 2 }, { name: "US", clicks: 1 }]);
  });

  it("sees links made by another process (the other color during a deploy) within a second", async () => {
    const other = await start(links.dataDir);
    await other.admin("links", { method: "POST", body: JSON.stringify({ slug: "elsewhere", target: "https://example.com/" }) });
    expect(links.app.store.bySlug("elsewhere")).toBeUndefined();
    expect(links.app.store.refresh()).toBe(true);
    expect((await visit("/elsewhere")).status).toBe(302);
    await other.stop();
  });

  it("migrates once, and refuses a database from a newer Links", () => {
    const path = join(links.dataDir, "links.db");
    const db = openDb(path);
    expect((db.prepare("SELECT count(*) n FROM migrations").get() as { n: number }).n).toBe(MIGRATIONS.length);
    db.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)").run(MIGRATIONS.length + 1, Date.now());
    db.close();
    expect(() => openDb(path)).toThrow(NewerDatabaseError);
    const raw = new DatabaseSync(path);
    raw.prepare("DELETE FROM migrations WHERE id = ?").run(MIGRATIONS.length + 1);
    raw.close();
  });
});

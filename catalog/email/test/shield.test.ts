import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.ts";
import { decide, DEFAULT_SETTINGS, normalizeIpv6, readShieldSettings } from "../src/shield.ts";

const TOKEN = "t".repeat(64);
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const notFound = () => Object.assign(new Error("not found"), { code: "ENOTFOUND" });
const shieldDns = {
  resolveMx: async (d: string) => (d === "gone.test" ? Promise.reject(notFound()) : d === "nomail.test" ? [{ exchange: ".", priority: 0 }] : d === "slow.test" ? Promise.reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })) : [{ exchange: `mx.${d}`, priority: 10 }]),
  resolve4: async (d: string) => (d === "aonly.test" ? ["192.0.2.1"] : Promise.reject(notFound())),
  resolve6: async () => Promise.reject(notFound()),
} as never;

// 100+ lines each, as a real download (a short one is taken for a broken download).
const filler = (prefix: string) => Array.from({ length: 120 }, (_, i) => `${prefix}${i}`);
const LISTS: Record<string, string[]> = {
  disposable: ["mailinator.com", "trashmail.test", ...filler("throwaway").map((d) => `${d}.test`)],
  toxicDomains: ["spammy.test", ...filler("toxic").map((d) => `${d}.test`)],
  spamIps: ["203.0.113.66", "2001:db8::66", ...filler("198.51.100.").slice(0, 100)],
  torExits: ["203.0.113.99", ...filler("198.18.0.").slice(0, 100)],
  datacenters: ["192.0.2.0/24", "100.64.0.0/16", ...Array.from({ length: 100 }, (_, i) => `10.${i}.0.0/16`)],
};

let app: App;
let base = "";
let dir = "";
let downloads: Record<string, Response | (() => Response)> = {};

async function start(withLists = true) {
  if (withLists) {
    mkdirSync(join(dir, "shield"), { recursive: true });
    for (const [name, lines] of Object.entries(LISTS)) writeFileSync(join(dir, "shield", `${name}.txt`), `${lines.join("\n")}\n`);
  }
  const fakeFetch = (async (url: string | URL) => {
    const d = downloads[String(url)];
    if (!d) throw new Error(`offline: ${String(url)}`);
    return typeof d === "function" ? d() : d;
  }) as typeof fetch;
  app = createApp({ dataDir: dir, token: TOKEN, secret: "s".repeat(64), version: "test", background: false, shieldDns, fetch: fakeFetch });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "email-shield-"));
  downloads = {};
});
afterEach(async () => {
  await app?.close();
  app = undefined as unknown as App;
  rmSync(dir, { recursive: true, force: true });
});

const admin = async (path: string, init: { method?: string; body?: unknown } = {}) => {
  const res = await fetch(`${base}/_admin/${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "X-Public-Url": base },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text };
};

const brand = async (name = "Piqo") => (await admin("brands", { body: { name, fromEmail: `news@${name.toLowerCase()}.app` } })).body.id as number;
const check = (b: number, email: string) => app.shield.checkAddress(b, email).then((v) => v.map((x) => x.check));
const signup = (b: number, s: Partial<Parameters<App["shield"]["checkSignup"]>[1]>) =>
  app.shield.checkSignup(b, { email: "ada@piqo.test", ip: "198.51.200.7", userAgent: BROWSER, honeypot: false, ...s }).then((v) => v.map((x) => x.check));

describe("the address checks", () => {
  it("invalid: the syntax, a null MX or no records at all; a DNS timeout refuses nobody", async () => {
    await start();
    const b = await brand();
    expect(await check(b, "ada@piqo.test")).toEqual([]);
    expect(await check(b, "ada@nomail.test")).toEqual(["invalid"]);
    expect(await check(b, "ada@gone.test")).toEqual(["invalid"]);
    expect(await check(b, "ada@aonly.test")).toEqual([]);
    expect(await check(b, "ada@slow.test")).toEqual([]);
    expect(await check(b, "ada..b@piqo.test")).toEqual(["invalid"]);
    expect((await app.shield.checkAddress(b, "ada@gone.test"))[0]!.detail).toBe("no mail server for gone.test");
  });

  it("temporary, spam-listed and free webmail domains, subdomains included; bounced with another brand", async () => {
    await start();
    const b = await brand();
    const other = await brand("Other");
    expect(await check(b, "x@mailinator.com")).toEqual(["disposable"]);
    expect(await check(b, "x@inbox.mailinator.com")).toEqual(["disposable"]);
    expect(await check(b, "x@spammy.test")).toEqual(["spamDomain"]);
    // Free webmail is off by default: on, gmail counts.
    expect(await check(b, "x@gmail.com")).toEqual([]);
    await admin(`brands/${b}/shield`, { method: "PUT", body: { checks: { freeMail: "flag" } } });
    expect(await check(b, "x@gmail.com")).toEqual(["freeMail"]);
    await admin(`brands/${other}/suppressions`, { body: { email: "gone@piqo.test" } });
    expect(await check(b, "gone@piqo.test")).toEqual([]);
    app.contacts.suppress(other, "gone@piqo.test", "bounce", "550");
    expect(await check(b, "gone@piqo.test")).toEqual(["bounced"]);
    expect(await check(other, "gone@piqo.test")).toEqual([]);
  });

  it("decide: refuse beats flag; off checks don't count", () => {
    const s = readShieldSettings(JSON.stringify({ checks: { bounced: "flag", freeMail: "off" } }));
    expect(decide([{ check: "bounced", detail: "" }], s).outcome).toBe("flag");
    expect(decide([{ check: "bounced", detail: "" }, { check: "disposable", detail: "" }], s).outcome).toBe("refuse");
    expect(decide([{ check: "freeMail", detail: "" }], s)).toEqual({ outcome: "ok", verdicts: [] });
    expect(readShieldSettings(null)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("the sign-up checks", () => {
  it("scripted browsers: no User-Agent, a script's, the honeypot, webdriver, or a form sent in under 2 seconds", async () => {
    await start();
    const b = await brand();
    expect(await signup(b, {})).toEqual([]);
    expect(await signup(b, { userAgent: "" })).toEqual(["scripted"]);
    expect(await signup(b, { userAgent: "curl/8.5.0" })).toEqual(["scripted"]);
    expect(await signup(b, { userAgent: "Mozilla/5.0 HeadlessChrome/126.0" })).toEqual(["scripted"]);
    expect(await signup(b, { honeypot: true })).toEqual(["scripted"]);
    expect(await signup(b, { webdriver: true })).toEqual(["scripted"]);
    expect(await signup(b, { elapsedMs: 800 })).toEqual(["scripted"]);
    expect(await signup(b, { elapsedMs: 9000 })).toEqual([]);
  });

  it("spam-listed IPs (v4 and v6, however v6 is written), Tor exits, data centers unless allowed", async () => {
    await start();
    const b = await brand();
    expect(await signup(b, { ip: "203.0.113.66" })).toEqual(["spamIp"]);
    expect(await signup(b, { ip: "2001:0db8:0000::0066" })).toEqual(["spamIp"]);
    expect(await signup(b, { ip: "203.0.113.99" })).toEqual(["abusiveIp"]);
    expect(await signup(b, { ip: "192.0.2.200" })).toEqual(["abusiveIp"]);
    expect(await signup(b, { ip: "100.64.255.255" })).toEqual(["abusiveIp"]);
    expect(await signup(b, { ip: "100.65.0.1" })).toEqual([]);
    await admin(`brands/${b}/shield`, { method: "PUT", body: { allowDatacenter: true } });
    expect(await signup(b, { ip: "192.0.2.200" })).toEqual([]);
    expect(normalizeIpv6("2001:DB8::66")).toBe("2001:db8:0:0:0:0:0:66");
  });

  it("AbuseIPDB, with a key: a confident report counts, and the answer is cached", async () => {
    await start();
    const b = await brand();
    let asked = 0;
    downloads["https://api.abuseipdb.com/api/v2/check?ipAddress=198.51.200.7&maxAgeInDays=90"] = () => (asked++, Response.json({ data: { abuseConfidenceScore: 90 } }));
    expect(await signup(b, {})).toEqual([]);
    expect((await admin("shield/abuseipdb", { method: "PUT", body: { key: "short" } })).status).toBe(400);
    expect((await admin("shield/abuseipdb", { method: "PUT", body: { key: "a".repeat(80) } })).body).toEqual({ abuseipdb: true });
    expect(await signup(b, {})).toEqual(["abusiveIp"]);
    expect(await signup(b, {})).toEqual(["abusiveIp"]);
    expect(asked).toBe(1);
    // Sealed at rest.
    expect(JSON.stringify(app.db.prepare("SELECT value FROM settings WHERE key = 'abuseipdbKey'").get())).not.toContain("a".repeat(80));
  });
});

describe("the lists", () => {
  it("downloads what's due, gunzips StopForumSpam's IPs, and keeps the last copy when a download fails or comes back nearly empty", async () => {
    await start(false);
    const b = await brand();
    const many = (lines: string[]) => `${lines.join("\n")}\n`;
    downloads["https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf"] = () => new Response(many(LISTS.disposable!));
    downloads["https://www.stopforumspam.com/downloads/toxic_domains_whole.txt"] = () => new Response(many(LISTS.toxicDomains!));
    downloads["https://www.stopforumspam.com/downloads/listed_ip_30_ipv46.gz"] = () => new Response(gzipSync(many(LISTS.spamIps!)));
    downloads["https://check.torproject.org/torbulkexitlist"] = () => new Response(many(LISTS.torExits!));
    downloads["https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt"] = () => new Response(many(LISTS.datacenters!));
    expect(await check(b, "x@mailinator.com")).toEqual([]);
    await app.shield.refresh();
    expect(await check(b, "x@mailinator.com")).toEqual(["disposable"]);
    expect(await signup(b, { ip: "203.0.113.66" })).toEqual(["spamIp"]);
    const status = (await admin(`brands/${b}/shield`)).body.lists as { name: string; entries: number; updatedAt: number | null; error: string | null }[];
    // Ranges that touch merge: 10.0.0.0/16 to 10.99.0.0/16 are one.
    expect(status.find((l) => l.name === "datacenters")).toMatchObject({ entries: 3, error: null });

    downloads["https://check.torproject.org/torbulkexitlist"] = () => new Response("1.2.3.4\n");
    downloads["https://www.stopforumspam.com/downloads/toxic_domains_whole.txt"] = () => new Response("nope", { status: 503 });
    await app.shield.refresh(true);
    const after = (await admin(`brands/${b}/shield`)).body.lists as { name: string; error: string | null }[];
    expect(after.find((l) => l.name === "torExits")!.error).toBe("the download was nearly empty");
    expect(after.find((l) => l.name === "toxicDomains")!.error).toBe("HTTP 503");
    expect(await signup(b, { ip: "203.0.113.99" })).toEqual(["abusiveIp"]);
    expect(readFileSync(join(dir, "shield", "torExits.txt"), "utf8")).toContain("203.0.113.99");
  });
});

describe("Shield in Email", () => {
  const post = (key: string, body: string) =>
    fetch(`${base}/subscribe/${key}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": BROWSER, Accept: "application/json" }, body });

  it("sign-up forms: a refused one is thanked and kept out; a flagged one is kept, flagged, and gets no campaigns", async () => {
    await start();
    const b = await brand();
    const list = (await admin(`brands/${b}/lists`, { body: { name: "News" } })).body;
    await admin(`brands/${b}/shield`, { method: "PUT", body: { checks: { disposable: "flag" } } });
    expect(await (await post(list.publicKey, "email=x%40spammy.test")).json()).toEqual({ ok: true, status: "subscribed" });
    expect((await admin(`brands/${b}/contacts?q=spammy`)).body.total).toBe(0);
    await post(list.publicKey, "email=y%40mailinator.com&_tz=Europe%2FBerlin");
    await post(list.publicKey, "email=ada%40piqo.test&_tz=Not%2FAZone");
    const flagged = (await admin(`brands/${b}/contacts?status=flagged`)).body;
    expect(flagged.contacts.map((c: { email: string; flags: string[] }) => [c.email, c.flags])).toEqual([["y@mailinator.com", ["disposable"]]]);
    expect(flagged.contacts[0].timezone).toBe("Europe/Berlin");
    expect((await admin(`brands/${b}/contacts?q=ada`)).body.contacts[0]).toMatchObject({ flags: null, timezone: null, device: "desktop", client: "Safari on macOS" });
    expect((await admin(`brands/${b}/audience?lists=${list.id}`)).body.count).toBe(1);
    const stats = (await admin(`brands/${b}/shield`)).body.stats;
    expect(stats).toMatchObject({ refused: 1, flagged: 1, byCheck: { spamDomain: { refused: 1 }, disposable: { flagged: 1 } }, bySource: { form: 2 } });
    // Approved: back in the audience.
    await admin(`brands/${b}/contacts/${flagged.contacts[0].id}/approve`, { method: "POST" });
    expect((await admin(`brands/${b}/audience?lists=${list.id}`)).body.count).toBe(2);
    expect(await (await fetch(`${base}/subscribe.js`)).text()).toContain('input[name="_hp"]');
  });

  it("the API refuses with a reason; an import is checked first, then refused rows are skipped and flagged ones flagged", async () => {
    await start();
    const b = await brand();
    const key = (await admin(`brands/${b}/keys`, { body: { name: "app" } })).body.key;
    const api = (body: unknown) => fetch(`${base}/contacts`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const refused = await api({ email: "x@mailinator.com" });
    expect([refused.status, (await refused.json()).message]).toEqual([422, "email: Shield refused this address: temporary email"]);
    expect((await api({ email: "ok@piqo.test" })).status).toBe(201);

    const csv = "email,name\nada@piqo.test,Ada\nx@mailinator.com,Spam\nz@spammy.test,Toxic\nb@gone.test,Gone\nnot-an-address,No\nada@piqo.test,Ada again\n";
    const preview = (await admin(`brands/${b}/import/check`, { body: { csv } })).body;
    expect(preview).toMatchObject({ rows: 5, total: 4, ok: 1, refuse: 3, flag: 0, unreadable: 1, byCheck: { disposable: { action: "refuse", count: 1 }, spamDomain: { count: 1 }, invalid: { count: 1 } } });
    expect(preview.examples.invalid).toEqual([{ email: "b@gone.test", detail: "no mail server for gone.test" }]);
    expect((await admin(`brands/${b}/contacts`)).body.total).toBe(1);

    const r = (await admin(`brands/${b}/import`, { body: { csv } })).body;
    expect(r).toMatchObject({ created: 1, updated: 1, refused: 3, flagged: 0 });
    expect(r.skipped).toContainEqual({ line: 3, reason: "Shield refused it: Temporary email" });
    const all = (await admin(`brands/${b}/import`, { body: { csv, include: "flagged" } })).body;
    expect(all).toMatchObject({ created: 3, flagged: 3 });
    expect((await admin(`brands/${b}/contacts?status=flagged`)).body.total).toBe(3);
  });

  it("a sync's page of rows: checked by Shield, subscribed, fields kept, nobody who left comes back", async () => {
    await start();
    const b = await brand();
    const list = (await admin(`brands/${b}/lists`, { body: { name: "Users" } })).body;
    await admin(`brands/${b}/import`, { body: { csv: "email\ngone@piqo.test\n", shield: false } });
    const gone = (await admin(`brands/${b}/contacts?q=gone`)).body.contacts[0];
    await admin(`brands/${b}/contacts/${gone.id}`, { method: "PATCH", body: { status: "unsubscribed" } });
    const rows = [
      { email: "Ada@Piqo.test", name: "Ada", fields: { plan: "pro" } },
      { email: "x@mailinator.com", name: "Spam" },
      { email: "not an address" },
      { email: "gone@piqo.test", name: "Gone" },
    ];
    const r = (await admin(`brands/${b}/sync`, { body: { rows, lists: [list.id], source: "sync:kagaz-api" } })).body;
    expect(r).toMatchObject({ created: 1, updated: 1, refused: 1 });
    expect((await admin(`brands/${b}/contacts?q=ada`)).body.contacts[0]).toMatchObject({ email: "ada@piqo.test", status: "subscribed", source: "sync:kagaz-api", fields: { plan: "pro" }, lists: [list.id] });
    expect((await admin(`brands/${b}/contacts?q=gone`)).body.contacts[0].status).toBe("unsubscribed");
    expect((await admin(`brands/${b}/shield`)).body.stats.bySource).toEqual({ sync: 1 });
    expect((await admin(`brands/${b}/sync`, { body: { rows: "nope" } })).status).toBe(400);
  });

  it("Clean the list: counts by check in the background, then flags or unsubscribes what you pick, leaving approved contacts alone", async () => {
    await start();
    const b = await brand();
    await admin(`brands/${b}/import`, { body: { csv: "email\nada@piqo.test\nx@mailinator.com\ny@trashmail.test\nz@spammy.test\nw@gone.test\n", shield: false } });
    const approved = (await admin(`brands/${b}/contacts?q=w%40gone`)).body.contacts[0];
    await admin(`brands/${b}/contacts/${approved.id}/approve`, { method: "POST" });
    expect((await admin(`brands/${b}/shield/scan/apply`, { body: { checks: ["disposable"] } })).status).toBe(409);
    await admin(`brands/${b}/shield/scan`, { method: "POST" });
    let scan;
    for (let i = 0; i < 50; i++) {
      scan = (await admin(`brands/${b}/shield`)).body.scan;
      if (scan.state !== "running") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(scan).toMatchObject({ state: "done", checked: 4, total: 4, byCheck: { disposable: 2, spamDomain: 1 } });
    expect((await admin(`brands/${b}/shield/scan/apply`, { body: { checks: ["disposable"], action: "flag" } })).body).toEqual({ changed: 2, action: "flag" });
    expect((await admin(`brands/${b}/contacts?status=flagged`)).body.total).toBe(2);
    await admin(`brands/${b}/shield/scan`, { method: "POST" });
    for (let i = 0; i < 50 && (await admin(`brands/${b}/shield`)).body.scan.state === "running"; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await admin(`brands/${b}/shield/scan/apply`, { body: { checks: ["spamDomain"], action: "unsubscribe" } })).body.changed).toBe(1);
    expect((await admin(`brands/${b}/contacts?q=spammy`)).body.contacts[0].status).toBe("unsubscribed");
  });
});

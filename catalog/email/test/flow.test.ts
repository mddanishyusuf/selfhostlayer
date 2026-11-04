import { createSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.ts";
import { dkimVerify } from "../src/dkim.ts";
import type { Dns } from "../src/domains.ts";
import { prune } from "../src/prune.ts";
import { snsSignedText, type SnsMessage } from "../src/ses.ts";
import { fakeSmtp, type FakeSmtp } from "./fake-smtp.ts";
import { TEST_CERT, TEST_KEY } from "./fixtures.ts";

const TOKEN = "t".repeat(64);
let app: App;
let base = "";
let dir = "";
let smtp: FakeSmtp;
const dnsRecords = new Map<string, string[]>();
const dns: Dns = { txt: async (n) => dnsRecords.get(n) ?? [], cname: async () => [] };
// Shield's mail-server lookups: every domain takes mail, but nomail.test (a null MX) and gone.test (no records).
const notFound = () => Object.assign(new Error("not found"), { code: "ENOTFOUND" });
const shieldDns = {
  resolveMx: async (d: string) => (d === "gone.test" ? Promise.reject(notFound()) : d === "nomail.test" ? [{ exchange: ".", priority: 0 }] : [{ exchange: `mx.${d}`, priority: 10 }]),
  resolve4: async () => Promise.reject(notFound()),
  resolve6: async () => Promise.reject(notFound()),
} as never;
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "email-"));
  dnsRecords.clear();
  smtp = await fakeSmtp({ security: "starttls", user: "u", pass: "p", refuse: (to) => (to.startsWith("nobody@") ? "550 5.1.1 no such user" : null) });
  app = createApp({ dataDir: dir, token: TOKEN, secret: "s".repeat(64), version: "test", background: false, smtpCa: TEST_CERT, dns, snsCertificate: TEST_CERT, shieldDns });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await app.close();
  await smtp.close();
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

/** A brand on the fake SMTP server, with piqo.app verified. */
async function readyBrand(): Promise<number> {
  const b = (await admin("brands", { body: { name: "Piqo", fromName: "Piqo", fromEmail: "news@piqo.app", address: "1 Main St\nBerlin" } })).body;
  expect((await admin(`brands/${b.id}/provider`, { method: "PUT", body: { provider: "smtp", host: "localhost", port: smtp.port, security: "starttls", username: "u", password: "p" } })).status).toBe(200);
  const d = (await admin(`brands/${b.id}/domains`, { body: { domain: "piqo.app" } })).body;
  const dkim = d.records.find((r: { purpose: string }) => r.purpose === "DKIM");
  dnsRecords.set(dkim.name, [dkim.value]);
  expect((await admin(`brands/${b.id}/domains/${d.id}/verify`, { method: "POST" })).body.status).toBe("verified");
  return b.id;
}

describe("the admin API", () => {
  it("answers only on this server with the token, and learns the public address", async () => {
    expect((await fetch(`${base}/_admin/info`)).status).toBe(401);
    expect((await fetch(`${base}/_admin/info`, { headers: { Authorization: `Bearer ${TOKEN}`, "X-Forwarded-For": "1.2.3.4" } })).status).toBe(404);
    expect((await admin("info")).body).toMatchObject({ version: "test", publicUrl: base, brands: 0 });
    expect(app.publicUrl()).toBe(base);
  });

  it("tests a provider: a real email out, and why one fails", async () => {
    const id = await readyBrand();
    const r = (await admin(`brands/${id}/provider/test`, { body: { to: "ada@example.com" } })).body;
    expect(r).toMatchObject({ status: "sent", error: null });
    expect(smtp.received.at(-1)!.to).toEqual(["ada@example.com"]);
    expect((await admin(`brands/${id}/provider/check`, { method: "POST" })).body).toMatchObject({ ok: true });
    await admin(`brands/${id}/provider`, { method: "PUT", body: { provider: "smtp", host: "localhost", port: smtp.port, username: "u", password: "nope" } });
    expect((await admin(`brands/${id}/provider/test`, { body: { to: "ada@example.com" } })).body).toMatchObject({ status: "failed", error: expect.stringContaining("535") });
    expect((await admin(`brands/${id}/provider/check`, { method: "POST" })).status).toBe(502);
  });
});

describe("contacts", () => {
  it("import from CSV (fields, lists, nobody resubscribed), search, export", async () => {
    const id = await readyBrand();
    const list = (await admin(`brands/${id}/lists`, { body: { name: "Newsletter" } })).body;
    await admin(`brands/${id}/contacts`, { body: { email: "gone@example.com", status: "unsubscribed" } });
    const csv = "Email,First Name,Last Name,Company,Plan\nada@example.com,Ada,Lovelace,Analytical,pro\nnot-an-email,,,,\ngone@example.com,Gone,,,\nBOB@example.com,Bob,,Acme,\n";
    const r = (await admin(`brands/${id}/import`, { body: { csv, lists: [list.id] } })).body;
    expect(r).toMatchObject({ created: 2, updated: 1, skipped: [{ line: 3, reason: "not-an-email isn't an email address" }] });
    const found = (await admin(`brands/${id}/contacts?q=lovelace`)).body;
    expect(found.contacts[0]).toMatchObject({ email: "ada@example.com", name: "Ada Lovelace", fields: { company: "Analytical", plan: "pro" }, status: "subscribed", lists: [list.id] });
    expect((await admin(`brands/${id}/contacts?status=unsubscribed`)).body.contacts.map((c: { email: string }) => c.email)).toEqual(["gone@example.com"]);
    expect((await admin(`brands/${id}/lists`)).body.lists[0]).toMatchObject({ subscribed: 2, total: 3 });
    const out = (await admin(`brands/${id}/export?list=${list.id}`)).body as string;
    expect(out.split("\n")[0]).toBe("email,name,status,lists,created_at,company,plan");
    expect(out).toContain("bob@example.com,Bob,subscribed,Newsletter,");
  });
});

describe("campaigns", () => {
  it("send to a list: merged, tracked, signed, with one-click unsubscribe; opens, clicks and unsubscribes are counted", async () => {
    const id = await readyBrand();
    const list = (await admin(`brands/${id}/lists`, { body: { name: "Newsletter" } })).body;
    const other = (await admin(`brands/${id}/lists`, { body: { name: "Customers" } })).body;
    for (const [email, name, lists] of [
      ["ada@example.com", "Ada Lovelace", [list.id]],
      ["bob@example.com", "Bob", [list.id, other.id]],
      ["cy@example.com", "Cy", [list.id]],
    ] as const)
      await admin(`brands/${id}/contacts`, { body: { email, name, lists } });
    await admin(`brands/${id}/suppressions`, { body: { email: "cy@example.com" } });
    const c = (await admin(`brands/${id}/campaigns`, { body: { name: "Launch", subject: "Hi {{first_name|there}}", html: '<html><body><p>Hello {{first_name}} &amp; welcome. <a href="https://piqo.app/launch?x=1&amp;y=2">See it</a></p></body></html>', lists: [list.id], excludeLists: [other.id] } })).body;
    const detail = (await admin(`brands/${id}/campaigns/${c.id}`)).body;
    expect([detail.audience, detail.problems]).toEqual([1, []]);
    expect((await admin(`brands/${id}/campaigns/${c.id}/schedule`, { body: {} })).body.status).toBe("sending");
    await app.mailer.drain();
    app.campaigns.tick();
    expect(smtp.received).toHaveLength(1);
    const got = smtp.received[0]!;
    expect(got.to).toEqual(["ada@example.com"]);
    expect(got.data).toContain("Subject: Hi Ada");
    expect(got.data).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    const key = (await admin(`brands/${id}/domains`)).body.domains[0].records[0].value.replace(/^.*p=/, "");
    expect(dkimVerify(Buffer.from(`${got.data}\r\n`), key).ok).toBe(true);
    const html = Buffer.from(got.data.split("Content-Type: text/html")[1]!.split("\r\n\r\n").slice(1).join("\r\n\r\n").split("\r\n--")[0]!.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
    expect(html).toContain("Hello Ada &amp; welcome");
    const click = /href="([^"]+\/t\/c\/[^"]+)"/.exec(html)![1]!.replace(/&amp;/g, "&");
    const open = /src="([^"]+\/t\/o\/[^"]+\.gif)"/.exec(html)![1]!;
    const unsub = /<(http[^>]+\/u\/[^>]+)>/.exec(got.data)![1]!;
    expect(html).toContain("1 Main St<br>Berlin");

    const r = await fetch(click, { redirect: "manual" });
    expect([r.status, r.headers.get("location")]).toEqual([302, "https://piqo.app/launch?x=1&y=2"]);
    expect((await fetch(click.replace("piqo.app%2Flaunch", "evil.example%2F"), { redirect: "manual" })).status).toBe(400);
    expect((await fetch(open)).headers.get("content-type")).toBe("image/gif");
    expect(await (await fetch(unsub)).text()).toContain("Unsubscribe from Piqo?");
    // RFC 8058: the inbox posts List-Unsubscribe=One-Click.
    expect((await fetch(unsub, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" })).status).toBe(200);
    const after = (await admin(`brands/${id}/campaigns/${c.id}`)).body;
    expect(after.campaign.status).toBe("sent");
    expect(after.campaign.stats).toMatchObject({ recipients: 1, sent: 1, opened: 1, clicked: 1, unsubscribed: 1 });
    expect(after.links).toEqual([{ url: "https://piqo.app/launch?x=1&y=2", clicks: 1, people: 1 }]);
    expect((await admin(`brands/${id}/contacts?q=ada`)).body.contacts[0].status).toBe("unsubscribed");
    expect((await admin(`brands/${id}/campaigns/${c.id}`, { method: "PATCH", body: { subject: "x" } })).status).toBe(409);
  });

  it("won't send from an unverified domain or to nobody, and pauses itself when too much bounces", async () => {
    const id = await readyBrand();
    const list = (await admin(`brands/${id}/lists`, { body: { name: "L" } })).body;
    const c = (await admin(`brands/${id}/campaigns`, { body: { name: "X", subject: "S", html: "<p>x</p>", fromEmail: "a@other.com", lists: [list.id] } })).body;
    const r = await admin(`brands/${id}/campaigns/${c.id}/schedule`, { body: {} });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("other.com isn't a verified domain");
    expect(r.body.error).toContain("no subscribed contacts");
    // 200 sent, 20 bounced: 9% bounced.
    const now = Date.now();
    app.db.prepare("INSERT INTO campaigns (id, brand_id, name, status, recipients, created_at, updated_at) VALUES (99, ?, 'Big', 'sending', 300, ?, ?)").run(id, now, now);
    const ins = app.db.prepare("INSERT INTO messages (id, brand_id, kind, campaign_id, to_email, from_email, status, send_at, created_at) VALUES (?, ?, 'campaign', 99, 'x@example.com', 'news@piqo.app', ?, ?, ?)");
    for (let i = 0; i < 300; i++) ins.run(`m${i}`, id, i < 200 ? "sent" : i < 220 ? "bounced" : "queued", now, now);
    app.campaigns.tick();
    const big = app.campaigns.get(id, 99);
    expect(big.status).toBe("paused");
    expect(big.pausedReason).toContain("9.1% of it bounced");
  });
});

describe("the transactional API (Resend's shape)", () => {
  async function key(id: number) {
    return (await admin(`brands/${id}/keys`, { body: { name: "app" } })).body.key as string;
  }
  const api = (k: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

  it("sends, with attachments and a template; tells its status; refuses what it must", async () => {
    const id = await readyBrand();
    const k = await key(id);
    expect((await api("em_nope", "/emails", { from: "a@piqo.app" })).status).toBe(403);
    expect(await (await fetch(`${base}/emails`, { method: "POST" })).json()).toMatchObject({ statusCode: 401, name: "missing_api_key" });
    const sent = await api(k, "/emails", { from: "Piqo <hello@piqo.app>", to: "ada@example.com", subject: "Your receipt", html: "<p>Thanks!</p>", reply_to: "help@piqo.app", attachments: [{ filename: "receipt.txt", content: Buffer.from("paid").toString("base64") }], tags: [{ name: "kind", value: "receipt" }] });
    const { id: emailId } = (await sent.json()) as { id: string };
    expect(sent.status).toBe(200);
    expect(emailId).toMatch(/^[0-9a-f]{24}$/);
    await app.mailer.drain();
    const got = smtp.received.at(-1)!;
    expect(got.data).toContain("Reply-To: help@piqo.app");
    expect(got.data).toContain('filename="receipt.txt"');
    expect(got.data).not.toContain("List-Unsubscribe");
    expect(got.data).not.toContain("/t/o/");
    expect(await (await api(k, `/emails/${emailId}`)).json()).toMatchObject({ object: "email", id: emailId, to: ["ada@example.com"], from: "Piqo <hello@piqo.app>", subject: "Your receipt", last_event: "sent" });
    // From a domain the brand hasn't verified: Resend's message.
    expect(await (await api(k, "/v1/emails", { from: "a@other.com", to: "x@example.com", subject: "s", text: "t" })).json()).toMatchObject({ statusCode: 403, message: expect.stringContaining("other.com domain is not verified") });
    expect((await api(k, "/emails", { from: "a@piqo.app", to: "x@example.com", text: "t" })).status).toBe(422);
    const t = (await admin(`brands/${id}/templates`, { body: { name: "Welcome", subject: "Welcome, {{name}}", html: "<p>Your code is {{code}}</p>" } })).body;
    const viaTemplate = (await (await api(k, "/emails", { from: "a@piqo.app", to: "x@example.com", template: { id: t.id, variables: { name: "Ada", code: "<42>" } } })).json()) as { id: string };
    await app.mailer.drain();
    expect(smtp.received.at(-1)!.data).toContain("Subject: Welcome, Ada");
    expect(smtp.received.at(-1)!.data).toContain("&lt;42&gt;");
    const batch = (await (await api(k, "/emails/batch", [{ from: "a@piqo.app", to: "x@example.com", subject: "1", text: "1" }, { from: "a@piqo.app", to: "y@example.com", subject: "2", text: "2" }])).json()) as { data: { id: string }[] };
    expect(batch.data).toHaveLength(2);
    expect((await api(k, "/emails/batch", [{ from: "a@piqo.app", to: "x@example.com", subject: "1", text: "1" }, { from: "bad" }])).status).toBe(422);
    // The same Idempotency-Key gets the same answer, and sends once.
    const once = { from: "a@piqo.app", to: "x@example.com", subject: "once", text: "1" };
    const a = (await (await api(k, "/emails", once, { "Idempotency-Key": "k1" })).json()) as { id: string };
    const b = (await (await api(k, "/emails", once, { "Idempotency-Key": "k1" })).json()) as { id: string };
    expect(a.id).toBe(b.id);
    expect(viaTemplate.id).not.toBe(a.id);
  });

  it("bounces suppress the address; contacts and events work too", async () => {
    const id = await readyBrand();
    const k = await key(id);
    const r = (await (await api(k, "/emails", { from: "a@piqo.app", to: "nobody@example.com", subject: "s", text: "t" })).json()) as { id: string };
    await app.mailer.drain();
    expect(await (await api(k, `/emails/${r.id}`)).json()).toMatchObject({ last_event: "bounced" });
    expect(await (await api(k, "/emails", { from: "a@piqo.app", to: "nobody@example.com", subject: "s", text: "t" })).json()).toMatchObject({ statusCode: 422, message: expect.stringContaining("suppression list") });
    const created = await api(k, "/contacts", { email: "Zed@Example.com", name: "Zed", fields: { plan: "pro" } });
    expect([created.status, ((await created.json()) as { status: string }).status]).toEqual([201, "subscribed"]);
    expect(await (await api(k, "/contacts/zed@example.com")).json()).toMatchObject({ email: "zed@example.com", fields: { plan: "pro" } });
    expect(await (await api(k, "/events", { email: "zed@example.com", name: "signed_up" })).json()).toEqual({ object: "event", started: 0 });
  });
});

describe("automations", () => {
  it("run from a list or an event: emails, waits, lists; leaving stops them", async () => {
    const id = await readyBrand();
    const list = (await admin(`brands/${id}/lists`, { body: { name: "Trial" } })).body;
    const done = (await admin(`brands/${id}/lists`, { body: { name: "Onboarded" } })).body;
    const a = (
      await admin(`brands/${id}/automations`, {
        body: {
          name: "Welcome",
          trigger: "list",
          triggerValue: list.id,
          steps: [
            { type: "email", subject: "Welcome {{first_name}}", html: "<p>Day one</p>" },
            { type: "wait", minutes: 60 },
            { type: "email", subject: "Day two", html: "<p>Day two</p>" },
            { type: "add_to_list", listId: done.id },
          ],
        },
      })
    ).body;
    expect((await admin(`brands/${id}/automations/${a.id}/status`, { body: { status: "active" } })).body.status).toBe("active");
    await admin(`brands/${id}/contacts`, { body: { email: "ada@example.com", name: "Ada", lists: [list.id] } });
    const now = Date.now();
    app.automations.tick(now);
    await app.mailer.drain();
    expect(smtp.received.at(-1)!.data).toContain("Subject: Welcome Ada");
    expect(app.automations.tick(now + 30 * 60_000)).toBe(0);
    app.automations.tick(now + 61 * 60_000);
    await app.mailer.drain();
    expect(smtp.received.at(-1)!.data).toContain("Subject: Day two");
    const runs = (await admin(`brands/${id}/automations/${a.id}`)).body;
    expect(runs.automation.runs).toMatchObject({ done: 1 });
    expect((await admin(`brands/${id}/contacts?list=${done.id}`)).body.total).toBe(1);

    const ev = (await admin(`brands/${id}/automations`, { body: { name: "Trial ending", trigger: "event", triggerValue: "trial_ending", steps: [{ type: "wait", minutes: 10 }, { type: "email", subject: "Ends {{data.day}}", html: "<p>x</p>" }] } })).body;
    await admin(`brands/${id}/automations/${ev.id}/status`, { body: { status: "active" } });
    const k = (await admin(`brands/${id}/keys`, { body: { name: "app" } })).body.key;
    const started = await fetch(`${base}/events`, { method: "POST", headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" }, body: JSON.stringify({ email: "bob@example.com", name: "trial_ending", data: { day: "Friday" } }) });
    expect(await started.json()).toEqual({ object: "event", started: 1 });
    // Bob unsubscribes before the wait is over: the run ends there.
    app.contacts.unsubscribe(id, "bob@example.com");
    app.automations.tick(Date.now() + 11 * 60_000);
    expect((await admin(`brands/${id}/automations/${ev.id}`)).body.automation.runs).toMatchObject({ exited: 1 });
  });
});

describe("signup forms", () => {
  it("subscribe, with double opt-in when the list has it; bots get nothing", async () => {
    const id = await readyBrand();
    const open = (await admin(`brands/${id}/lists`, { body: { name: "Open" } })).body;
    const confirmed = (await admin(`brands/${id}/lists`, { body: { name: "Confirmed", doubleOptIn: true } })).body;
    const post = (key: string, body: string, headers: Record<string, string> = {}) => fetch(`${base}/subscribe/${key}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": BROWSER, ...headers }, body, redirect: "manual" });
    expect(await (await post(open.publicKey, "email=ada%40example.com&name=Ada&company=Analytical", { Accept: "application/json" })).json()).toEqual({ ok: true, status: "subscribed" });
    expect((await admin(`brands/${id}/contacts?q=ada`)).body.contacts[0]).toMatchObject({ status: "subscribed", fields: { company: "Analytical" }, source: "form" });
    const redirected = await post(open.publicKey, "email=bob%40example.com&redirect=https%3A%2F%2Fpiqo.app%2Fthanks");
    expect([redirected.status, redirected.headers.get("location")]).toEqual([303, "https://piqo.app/thanks"]);
    await post(open.publicKey, "email=bot%40example.com&_hp=gotcha");
    expect((await admin(`brands/${id}/contacts?q=bot`)).body.total).toBe(0);

    const r = await post(confirmed.publicKey, "email=cy%40example.com");
    expect(await r.text()).toContain("Check your inbox");
    await app.mailer.drain();
    const mail = smtp.received.at(-1)!;
    expect(mail.data).toContain("Subject: Confirm your subscription to Piqo");
    const link = /(http:\/\/127\.0\.0\.1:\d+\/confirm\/[\w.-]+)/.exec(mail.data.replace(/=\r\n/g, "").replace(/=3D/g, "="))![1]!;
    expect((await admin(`brands/${id}/contacts?q=cy`)).body.contacts[0].status).toBe("unconfirmed");
    // Mail scanners open every link: opening it only asks, the button confirms.
    expect(await (await fetch(link)).text()).toContain(">Confirm</button>");
    expect((await admin(`brands/${id}/contacts?q=cy`)).body.contacts[0].status).toBe("unconfirmed");
    expect(await (await fetch(link, { method: "POST" })).text()).toContain("Thanks for confirming");
    expect((await admin(`brands/${id}/contacts?q=cy`)).body.contacts[0].status).toBe("subscribed");
    expect((await fetch(link.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).status).toBe(400);
  });

  it("change nobody who's already a contact: no new name, no resubscribing, nothing confirmed but from the inbox", async () => {
    const id = await readyBrand();
    const open = (await admin(`brands/${id}/lists`, { body: { name: "Open" } })).body;
    const confirmed = (await admin(`brands/${id}/lists`, { body: { name: "Confirmed", doubleOptIn: true } })).body;
    const post = (key: string, body: string, headers: Record<string, string> = {}) => fetch(`${base}/subscribe/${key}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": BROWSER, ...headers }, body, redirect: "manual" });
    const contact = async (q: string) => (await admin(`brands/${id}/contacts?q=${q}`)).body.contacts[0];
    // A name and fields come only with a new address, however it's written.
    await post(open.publicKey, "email=dee%40example.com&name=Dee&plan=pro");
    await post(open.publicKey, "email=%20DEE%40example.com%20&name=Mallory&plan=free");
    expect(await contact("dee")).toMatchObject({ name: "Dee", fields: { plan: "pro" }, status: "subscribed" });
    // Still to confirm: a list without double opt-in doesn't skip it.
    await post(confirmed.publicKey, "email=eve%40example.com");
    await post(open.publicKey, "email=eve%40example.com");
    expect((await contact("eve")).status).toBe("unconfirmed");
    // Unsubscribed: the form doesn't bring them back; the link it sends does, with a click.
    app.contacts.unsubscribe(id, "dee@example.com");
    expect(await (await post(open.publicKey, "email=dee%40example.com")).text()).toContain("Check your inbox");
    expect((await contact("dee")).status).toBe("unsubscribed");
    await app.mailer.drain();
    const again = () => smtp.received.filter((m) => m.data.includes("Subject: Confirm you'd like emails from Piqo again"));
    expect(again()).toHaveLength(1);
    const link = /(http:\/\/127\.0\.0\.1:\d+\/confirm\/[\w.-]+)/.exec(again()[0]!.data.replace(/=\r\n/g, "").replace(/=3D/g, "="))![1]!;
    await fetch(link);
    expect((await contact("dee")).status).toBe("unsubscribed");
    expect(await (await fetch(link, { method: "POST" })).text()).toContain("Thanks for confirming");
    expect((await contact("dee")).status).toBe("subscribed");
    // Unsubscribed again: that link is spent, and a day's one link has gone already.
    app.contacts.unsubscribe(id, "dee@example.com");
    expect(await (await fetch(link, { method: "POST" })).text()).toContain("can't be subscribed again");
    await post(open.publicKey, "email=dee%40example.com");
    await app.mailer.drain();
    expect(again()).toHaveLength(1);
    expect((await contact("dee")).status).toBe("unsubscribed");
    // After signing up, only the brand's own sites, or the form's, come next.
    const away = await post(open.publicKey, "email=fay%40example.com&redirect=https%3A%2F%2Fevil.example%2F");
    expect([away.status, away.headers.get("location")]).toEqual([200, null]);
    const home = await post(open.publicKey, "email=gus%40example.com&redirect=https%3A%2F%2Fshop.example%2Fthanks", { Origin: "https://shop.example" });
    expect([home.status, home.headers.get("location")]).toEqual([303, "https://shop.example/thanks"]);
  });
});

describe("Amazon SES's events", () => {
  it("bounces and complaints from SNS (signature checked, our topic only) suppress addresses", async () => {
    const id = await readyBrand();
    app.brands.setSesEvents(id, { configurationSet: "shl-1", topicArn: "arn:aws:sns:eu-west-1:1:shl-1" });
    app.db.prepare("INSERT INTO messages (id, brand_id, kind, to_email, from_email, status, send_at, created_at, provider_id) VALUES ('aaaaaaaaaaaaaaaaaaaaaaaa', ?, 'transactional', 'gone@example.com', 'a@piqo.app', 'sent', 0, 0, 'ses-msg-1')").run(id);
    const notify = (message: unknown, topic = "arn:aws:sns:eu-west-1:1:shl-1") => {
      const m: SnsMessage = { Type: "Notification", MessageId: "n1", TopicArn: topic, Message: JSON.stringify(message), Timestamp: new Date().toISOString(), SignatureVersion: "2", Signature: "", SigningCertURL: "https://sns.eu-west-1.amazonaws.com/c.pem" };
      m.Signature = createSign("RSA-SHA256").update(snsSignedText(m)).sign(TEST_KEY, "base64");
      return fetch(`${base}/webhooks/ses`, { method: "POST", body: JSON.stringify(m) });
    };
    expect((await notify({ eventType: "Bounce" }, "arn:aws:sns:eu-west-1:1:someone-else")).status).toBe(403);
    expect((await notify({ eventType: "Bounce", bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "gone@example.com", diagnosticCode: "550 5.1.1" }] }, mail: { messageId: "ses-msg-1" } })).status).toBe(200);
    expect(app.contacts.isSuppressed(id, "gone@example.com")).toBe(true);
    expect((app.db.prepare("SELECT status FROM messages WHERE id = 'aaaaaaaaaaaaaaaaaaaaaaaa'").get() as { status: string }).status).toBe("bounced");
    await notify({ eventType: "Complaint", complaint: { complainedRecipients: [{ emailAddress: "angry@example.com" }] }, mail: { messageId: "none" } });
    expect((await admin(`brands/${id}/suppressions`)).body.items.map((s: { email: string; reason: string }) => [s.email, s.reason]).sort()).toEqual([
      ["angry@example.com", "complaint"],
      ["gone@example.com", "bounce"],
    ]);
  });
});

describe("the daily prune", () => {
  it("drops old bodies, then old messages, never what's still queued", async () => {
    const id = await readyBrand();
    const old = Date.now() - 40 * 86_400_000;
    app.db.prepare("INSERT INTO messages (id, brand_id, kind, to_email, from_email, status, send_at, created_at) VALUES ('b1', ?, 'transactional', 'a@x.com', 'a@piqo.app', 'sent', 0, ?), ('b2', ?, 'transactional', 'a@x.com', 'a@piqo.app', 'queued', 0, ?)").run(id, old, id, old);
    app.db.prepare("INSERT INTO message_bodies (message_id, payload) VALUES ('b1', '{}'), ('b2', '{}')").run();
    expect(prune(app.db)).toEqual({ bodies: 1, messages: 0 });
    expect(prune(app.db, Date.now() + 400 * 86_400_000)).toEqual({ bodies: 0, messages: 1 });
  });
});

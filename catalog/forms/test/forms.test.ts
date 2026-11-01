import { createHmac } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accepts, checkAnswers } from "../src/answers.ts";
import { createApp, type App } from "../src/app.ts";
import { CLIENT_JS } from "../src/client.ts";
import { EMBED_JS } from "../src/page.ts";
import { checkSchema, emptySchema, visible, type Field } from "../src/schema.ts";

const TOKEN = "t".repeat(64);
const field = (f: Partial<Field> & { id: string; type: Field["type"] }): Partial<Field> => ({ label: f.id, ...f });

const SURVEY = {
  layout: "conversational",
  theme: { accent: "#e11d48", mode: "dark" },
  fields: [
    field({ id: "name", type: "short_text", required: true }),
    field({ id: "email", type: "email", required: true }),
    field({ id: "role", type: "choice", options: ["Founder", "Engineer", "Other"], required: true }),
    field({ id: "other", type: "short_text", required: true, showIf: { field: "role", op: "is", value: "Other" } }),
    field({ id: "tools", type: "multi", options: ["Links", "Analytics", "Email"] }),
    field({ id: "stars", type: "rating", max: 5, required: true }),
    field({ id: "nps", type: "scale" }),
    field({ id: "intro", type: "statement", label: "Almost done" }),
    field({ id: "cv", type: "file", accept: ".pdf,image/*" }),
    field({ id: "ref", type: "hidden", param: "ref" }),
  ],
};

describe("schemas", () => {
  it("are checked: types, ids, choices, logic only on earlier fields, ratings to 5 or 10", () => {
    const s = checkSchema(SURVEY);
    expect(s.fields.find((f) => f.id === "stars")).toMatchObject({ max: 5 });
    expect(s.fields.find((f) => f.id === "intro")!.required).toBe(false);
    expect(s.theme).toEqual({ accent: "#e11d48", mode: "dark", logo: "" });
    const bad = (fields: unknown[]) => () => checkSchema({ fields });
    expect(bad([{ id: "a", type: "nope" }])).toThrow(/must be one of/);
    expect(bad([{ id: "a", type: "short_text" }, { id: "a", type: "email" }])).toThrow(/used twice/);
    expect(bad([{ id: "a", type: "choice", options: [] }])).toThrow(/at least one choice/);
    expect(bad([{ id: "a", type: "short_text", showIf: { field: "b", op: "is", value: "x" } }, { id: "b", type: "short_text" }])).toThrow(/before this one/);
    expect(bad([{ id: "a", type: "rating", max: 7 }])).toThrow(/5 or 10/);
    expect(() => checkSchema({ fields: [], theme: { accent: "red" } })).toThrow(/color/);
    expect(checkSchema(emptySchema()).fields).toHaveLength(3);
  });

  it("show a field by an earlier answer, and hide what depends on a hidden one", () => {
    const s = checkSchema({
      fields: [
        { id: "a", type: "choice", options: ["x", "y"] },
        { id: "b", type: "short_text", showIf: { field: "a", op: "is", value: "y" } },
        { id: "c", type: "short_text", showIf: { field: "b", op: "answered", value: "" } },
        { id: "n", type: "number" },
        { id: "d", type: "short_text", showIf: { field: "n", op: "gt", value: "10" } },
      ],
    });
    const [, b, c, , d] = s.fields as [Field, Field, Field, Field, Field];
    expect(visible(b, { a: "x" }, s.fields)).toBe(false);
    expect(visible(b, { a: "Y" }, s.fields)).toBe(true);
    expect(visible(c, { a: "x", b: "hi" }, s.fields)).toBe(false);
    expect(visible(c, { a: "y", b: "hi" }, s.fields)).toBe(true);
    expect([visible(d, { n: 11 }, s.fields), visible(d, { n: 3 }, s.fields), visible(d, {}, s.fields)]).toEqual([true, false, false]);
  });
});

describe("answers", () => {
  const s = checkSchema(SURVEY);
  const ok = { name: "Ada", email: "ADA@Example.com", role: "Founder", stars: 5 };

  it("are checked by type; hidden fields' answers are dropped; required ones must be there", () => {
    const r = checkAnswers(s, { answers: { ...ok, other: "dropped: role isn't Other", tools: ["Email", "Links"], nps: 9, ref: "newsletter", intro: "x" } });
    expect(r.answers).toEqual({ name: "Ada", email: "ada@example.com", role: "Founder", tools: ["Links", "Email"], stars: 5, nps: 9, ref: "newsletter" });
    expect(() => checkAnswers(s, { answers: { ...ok, role: "Other" } })).toThrow(expect.objectContaining({ field: "other" }));
    expect(() => checkAnswers(s, { answers: { ...ok, email: "nope" } })).toThrow(/isn't an email address/);
    expect(() => checkAnswers(s, { answers: { ...ok, role: "CEO" } })).toThrow(/isn't one of the choices/);
    expect(() => checkAnswers(s, { answers: { ...ok, stars: 6 } })).toThrow(/1 to 5/);
    expect(() => checkAnswers(s, { answers: { ...ok, tools: ["Nope"] } })).toThrow(/among the choices/);
    expect(() => checkAnswers(s, { answers: { email: "a@b.co" } })).toThrow(expect.objectContaining({ field: "name" }));
  });

  it("take files announced by name, type and size, of the kinds the field allows, up to 10 MB", () => {
    const pdf = { field: "cv", name: "cv.pdf", type: "application/pdf", size: 8 };
    const r = checkAnswers(s, { answers: ok, files: [pdf] });
    expect(r.answers.cv).toBe("cv.pdf");
    expect(r.uploads[0]).toEqual({ fieldId: "cv", name: "cv.pdf", type: "application/pdf", size: 8, index: 0 });
    expect(() => checkAnswers(s, { answers: ok, files: [{ ...pdf, name: "x.exe", type: "application/x-msdownload" }] })).toThrow(/isn't a kind of file/);
    expect(() => checkAnswers(s, { answers: ok, files: [{ ...pdf, size: 11 * 1024 * 1024 }] })).toThrow(/10 MB/);
    for (const bad of [[pdf, pdf], [{ ...pdf, field: "name" }], [{ ...pdf, size: -1 }], [{ ...pdf, size: 1.5 }], { cv: pdf }]) expect(() => checkAnswers(s, { answers: ok, files: bad })).toThrow(/couldn't be read|must list/);
    expect([accepts(".pdf,image/*", "a.PNG", "image/png"), accepts("", "a", "b/c"), accepts(".pdf", "a.png", "image/png")]).toEqual([true, true, false]);
  });
});

describe("the page and its scripts", () => {
  it("parse as JavaScript", () => {
    expect(() => new Function(CLIENT_JS)).not.toThrow();
    expect(() => new Function(EMBED_JS)).not.toThrow();
  });
});

describe("Forms over HTTP", () => {
  let app: App;
  let base = "";
  let dir = "";
  const hooks: { url: string; headers: Record<string, string>; body: string; redirect?: string }[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    hooks.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body), redirect: init?.redirect });
    return new Response(JSON.stringify({ id: "x" }), { status: String(url).includes("broken") ? 500 : String(url).includes("moved") ? 302 : 200 });
  }) as typeof fetch;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "forms-"));
    hooks.length = 0;
    app = createApp({ dataDir: dir, token: TOKEN, secret: "s".repeat(64), releaseDir: dir, version: "test", background: false, fetch: fakeFetch, minMs: 50, diskFloor: 0 });
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const admin = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(`${base}/_admin/${path}`, { method: init.method ?? (init.body === undefined ? "GET" : "POST"), headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "X-Public-Url": base }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    const text = await res.text();
    return { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
  };
  /** Loads the page as a person would and gives back its start token. */
  async function load(slug: string) {
    const res = await fetch(`${base}/f/${slug}?ref=tour`);
    const html = await res.text();
    const cfg = JSON.parse(/<script type="application\/json" id="cfg">([\s\S]*?)<\/script>/.exec(html)![1]!);
    return { res, html, cfg };
  }
  const headers = (type: string, ua: string) => ({ "Content-Type": type, "User-Agent": ua, "X-Forwarded-For": "81.2.69.160", Referer: "https://news.ycombinator.com/item?id=1" });
  const submit = (slug: string, body: unknown, ua = "Mozilla/5.0 (Macintosh) Chrome/130.0 Safari/537.36") => fetch(`${base}/f/${slug}/submit`, { method: "POST", headers: headers("application/json", ua), body: JSON.stringify(body) });
  /** As the page sends a response with files: a line of JSON, then the files' bytes. */
  const submitFiles = (slug: string, head: Record<string, unknown>, bytes: Buffer[], ua = "Mozilla/5.0 (Macintosh) Chrome/130.0 Safari/537.36") =>
    fetch(`${base}/f/${slug}/submit`, { method: "POST", headers: headers("application/x-forms-response", ua), body: Buffer.concat([Buffer.from(JSON.stringify(head) + "\n"), ...bytes]) });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Waits until `ok` holds (for what only shows on disk), at most 5 s. */
  const until = async (ok: () => boolean, what: string) => {
    for (const end = Date.now() + 5000; !ok(); await wait(20)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  };

  it("serves a form, counts views and starts, refuses spam and wrong answers, keeps the right ones", async () => {
    const form = (await admin("forms", { body: { title: "Tell us about you", schema: SURVEY } })).body;
    expect((await admin("forms")).body.forms[0]).toMatchObject({ title: "Tell us about you", responses: 0, closed: null });
    const { res, html, cfg } = await load(form.slug);
    expect(res.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[^']+'; .*frame-ancestors \*/);
    expect(html).toContain('<html lang="en" data-mode="dark" style="--accent:#e11d48">');
    expect(cfg).toMatchObject({ slug: form.slug, title: "Tell us about you", base: `/f/${form.slug}` });
    for (const b of ["view", "start"]) await fetch(`${base}/f/${form.slug}/${b}`, { method: "POST", headers: { "User-Agent": "Mozilla/5.0 Chrome/130.0" }, body: "{}" });
    await fetch(`${base}/f/${form.slug}/view`, { method: "POST", headers: { "User-Agent": "Googlebot/2.1" } });
    const answers = { name: "Ada", email: "ada@example.com", role: "Other", other: "Writer", stars: 4, nps: 10, ref: "tour" };
    expect(await (await submit(form.slug, { t: cfg.token, answers })).json()).toEqual({ error: "That was too fast: try again." });
    await wait(60);
    expect(await (await submit(form.slug, { t: "123.forged", answers })).json()).toEqual({ error: "The page is too old: load it again." });
    const missing = await submit(form.slug, { t: cfg.token, answers: { ...answers, other: "" } });
    expect([missing.status, await missing.json()]).toEqual([422, { error: "other: an answer is required", field: "other" }]);
    expect(await (await submit(form.slug, { t: cfg.token, hp: "http://spam.example", answers })).json()).toEqual({ ok: true });
    // Files come after the answers, never in them: a page from before that is told to load again.
    const pdf = Buffer.from("%PDF-1.4 hello");
    const old = await submit(form.slug, { t: cfg.token, answers, files: { cv: { name: "cv.pdf", type: "application/pdf", data: pdf.toString("base64") } } });
    expect([old.status, (await old.json()).error]).toEqual([409, "This page changed since it was loaded: load it again to send files."]);
    const announce = (size = pdf.length) => ({ t: cfg.token, answers, files: [{ field: "cv", name: "cv.pdf", type: "application/pdf", size }] });
    const short = await submitFiles(form.slug, announce(pdf.length + 5), [pdf]);
    expect([short.status, (await short.json()).error]).toEqual([422, "a file didn't come whole: try again"]);
    const extra = await submitFiles(form.slug, announce(), [pdf, Buffer.from("more")]);
    expect([extra.status, (await extra.json()).error]).toEqual([422, "more came than the files announced"]);
    // Two uploads at once from an address: a third waits its turn, and one that stalls frees its slot when it ends.
    const from = { ...headers("application/x-forms-response", "Mozilla/5.0 Chrome/130.0"), "X-Forwarded-For": "81.2.69.200" };
    const stalled = [0, 1].map(() => {
      const r = request(`${base}/f/${form.slug}/submit`, { method: "POST", headers: { ...from, "Content-Length": "100000" } });
      r.on("error", () => {});
      r.write(JSON.stringify(announce(50_000)) + "\nsome bytes");
      return r;
    });
    const staging = join(dir, "uploads", ".incoming");
    await until(() => readdirSync(staging).length === 2, "both stalled uploads to start");
    const third = await fetch(`${base}/f/${form.slug}/submit`, { method: "POST", headers: from, body: Buffer.concat([Buffer.from(JSON.stringify(announce()) + "\n"), pdf]) });
    expect([third.status, (await third.json()).error]).toEqual([503, "Busy with other files: try again in a minute."]);
    for (const r of stalled) r.destroy();
    await until(() => readdirSync(staging).length === 0, "the stalled uploads' files to go");
    const ok = await submitFiles(form.slug, announce(), [pdf]);
    expect(ok.status).toBe(200);
    // Nothing waits in the staging folder after: kept files moved, the rest removed.
    expect(readdirSync(join(dir, "uploads", ".incoming"))).toEqual([]);
    const { id } = (await ok.json()) as { id: number };
    const r = (await admin(`forms/${form.id}/responses/${id}`)).body;
    expect(r.answers).toEqual({ ...answers, cv: "cv.pdf" });
    expect(r.meta).toMatchObject({ device: "desktop", browser: "Chrome", referrer: "news.ycombinator.com" });
    expect(r.meta.duration).toBeGreaterThanOrEqual(50);
    const file = await fetch(`${base}/_admin/forms/${form.id}/files/${r.files[0].id}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect([file.headers.get("content-disposition"), await file.text()]).toEqual(["attachment; filename=\"cv.pdf\"; filename*=UTF-8''cv.pdf", "%PDF-1.4 hello"]);
    // A name in any script downloads: filename* has it, beside a plain one.
    const named = await submitFiles(form.slug, { t: cfg.token, answers, files: [{ field: "cv", name: "résumé 简历.pdf", type: "application/pdf", size: pdf.length }] }, [pdf]);
    const other = (await admin(`forms/${form.id}/responses/${((await named.json()) as { id: number }).id}`)).body;
    const download = await fetch(`${base}/_admin/forms/${form.id}/files/${other.files[0].id}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect([download.status, download.headers.get("content-disposition")]).toEqual([200, `attachment; filename="r_sum_ __.pdf"; filename*=UTF-8''${encodeURIComponent("résumé 简历.pdf")}`]);
    await admin(`forms/${form.id}/responses/${other.id}`, { method: "DELETE" });
    const list = (await admin(`forms/${form.id}/responses?q=writer`)).body;
    expect(list.total).toBe(1);
    const csv = (await admin(`forms/${form.id}/export`)).body as string;
    expect(csv.split("\n")[0]).toBe("submitted_at,name,email,role,other,tools,stars,nps,cv,ref,duration_seconds,country,device,referrer");
    expect(csv.split("\n")[1]).toContain(",Ada,ada@example.com,Other,Writer,,4,10,cv.pdf,tour,");
    const ins = (await admin(`forms/${form.id}/insights`)).body;
    expect(ins).toMatchObject({ views: 1, starts: 1, responses: 1, completion: 1 });
    expect(ins.fields.find((f: { id: string }) => f.id === "role").counts).toEqual([
      { value: "Founder", count: 0 },
      { value: "Engineer", count: 0 },
      { value: "Other", count: 1 },
    ]);
    expect(ins.fields.find((f: { id: string }) => f.id === "nps")).toMatchObject({ average: 10, nps: 100 });
    expect((await admin(`forms/${form.id}/responses/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await admin(`forms/${form.id}/responses`)).body.total).toBe(0);
  });

  it("close by hand, at a time, or when full; the address can change; deleting takes the responses", async () => {
    const form = (await admin("forms", { body: { title: "Signup", schema: { fields: [{ id: "email", type: "email", required: true }] } } })).body;
    await admin(`forms/${form.id}`, { method: "PATCH", body: { maxResponses: 1, closedMessage: "We're full, sorry." } });
    const { cfg } = await load(form.slug);
    await wait(60);
    expect((await submit(form.slug, { t: cfg.token, answers: { email: "a@example.com" } })).status).toBe(200);
    const full = await submit(form.slug, { t: cfg.token, answers: { email: "b@example.com" } });
    expect([full.status, await full.json()]).toEqual([410, { error: "We're full, sorry." }]);
    expect(await (await fetch(`${base}/f/${form.slug}`)).text()).toContain("We&#39;re full, sorry.".replace("&#39;", "'"));
    expect((await admin(`forms/${form.id}`, { method: "PATCH", body: { slug: "Bad Slug" } })).status).toBe(400);
    const moved = (await admin(`forms/${form.id}`, { method: "PATCH", body: { slug: "signup", maxResponses: null, status: "closed" } })).body;
    expect(moved.slug).toBe("signup");
    const shown = (await admin(`forms/${moved.id}`)).body;
    expect(shown.closed).toBe("closed");
    // The builder's preview shows it anyway, with a token only the admin API gives out.
    expect(await (await fetch(`${base}/f/signup?preview=${shown.preview}`)).text()).toContain('"preview":true');
    expect(await (await fetch(`${base}/f/signup?preview=forged${shown.preview.slice(6)}`)).text()).toContain("We're full, sorry.");
    expect((await fetch(`${base}/f/${form.slug}`)).status).toBe(404);
    expect((await admin(`forms/${form.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await admin("forms")).body.forms).toEqual([]);
  });

  it("tell a webhook (signed) and the owner and respondent by email, through Email's API", async () => {
    expect((await admin("settings", { method: "PUT", body: { email: { url: "https://email.example.com", key: "em_short", from: "forms@piqo.app" } } })).status).toBe(400);
    await admin("settings", { method: "PUT", body: { email: { url: "https://email.example.com/", key: `em_${"k".repeat(30)}`, from: "Piqo <forms@piqo.app>", brand: "Piqo" } } });
    expect((await admin("settings")).body.email).toEqual({ url: "https://email.example.com", from: "Piqo <forms@piqo.app>", brand: "Piqo", keyHint: "em_kkkkkk" });
    const form = (await admin("forms", { body: { title: "Contact", schema: emptySchema() } })).body;
    const f = (await admin(`forms/${form.id}`, { method: "PATCH", body: { notify: { email: "owner@piqo.app", receiptField: "email", webhook: "https://hooks.example.com/forms" } } })).body;
    const { cfg } = await load(form.slug);
    await wait(60);
    await submit(form.slug, { t: cfg.token, answers: { name: "Ada", email: "ada@example.com", message: "Hi <there>" } });
    expect(await app.notifier.tick()).toBe(3);
    const hook = hooks.find((h) => h.url === "https://hooks.example.com/forms")!;
    expect(hook.headers["X-Forms-Signature"]).toBe(`sha256=${createHmac("sha256", f.notify.webhookSecret).update(hook.body).digest("hex")}`);
    expect(JSON.parse(hook.body).response.fields.map((x: { id: string; value: unknown }) => [x.id, x.value])).toEqual([
      ["name", "Ada"],
      ["email", "ada@example.com"],
      ["message", "Hi <there>"],
    ]);
    const mails = hooks.filter((h) => h.url === "https://email.example.com/emails").map((h) => ({ auth: h.headers.Authorization, ...JSON.parse(h.body) }));
    expect(mails.map((m) => [m.to, m.subject, m.reply_to])).toEqual([
      ["owner@piqo.app", "New response to Contact", "ada@example.com"],
      ["ada@example.com", "Your answers to Contact", undefined],
    ]);
    expect(mails[0].auth).toBe(`Bearer em_${"k".repeat(30)}`);
    expect(mails[0].html).toContain("Hi &lt;there&gt;");
    // The copy goes to whatever address was typed, so it never repeats what was typed.
    expect(mails[1].html).not.toContain("there");
    expect(mails[1].html).toContain("Answers you typed aren't repeated in this email.");
    // One copy an address a day from a form, however it's written.
    const second = await load(form.slug);
    await wait(60);
    await submit(form.slug, { t: second.cfg.token, answers: { name: "Mallory", email: "ADA@example.com", message: "Buy now" } });
    await app.notifier.tick();
    expect((await admin(`forms/${form.id}`)).body.deliveries.find((d: { kind: string }) => d.kind === "receipt")).toMatchObject({ status: "done", error: "a copy went to this address in the last day" });
    // A webhook's redirect isn't followed: it could point anywhere, this server included.
    expect(hook.redirect).toBe("manual");
    await admin(`forms/${form.id}`, { method: "PATCH", body: { notify: { webhook: "https://moved.example.com/" } } });
    expect((await admin(`forms/${form.id}/test-webhook`, { method: "POST" })).body).toEqual({ status: 302, error: "it answered 302" });
    // A webhook that fails is tried again later; with no copy, replies still go to whoever answered.
    await admin(`forms/${form.id}`, { method: "PATCH", body: { notify: { webhook: "https://broken.example.com/", receiptField: "" } } });
    const again = await load(form.slug);
    await wait(60);
    await submit(form.slug, { t: again.cfg.token, answers: { name: "Bob", email: "bob@example.com" } });
    await app.notifier.tick();
    expect(JSON.parse(hooks.filter((h) => h.url === "https://email.example.com/emails").at(-1)!.body)).toMatchObject({ to: "owner@piqo.app", reply_to: "bob@example.com" });
    expect((await admin(`forms/${form.id}`)).body.deliveries.find((d: { kind: string }) => d.kind === "webhook")).toMatchObject({ status: "pending", attempts: 1, error: "the webhook answered 500" });
    expect(await (await fetch(`${base}/embed.js`)).text()).toContain("data-shl-form");
  });
});

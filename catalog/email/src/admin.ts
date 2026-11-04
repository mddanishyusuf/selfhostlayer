// The admin API, /_admin/…, for the panel: brands and everything in them. It
// answers only requests made on this server with the token made at install
// (EMAIL_ADMIN_TOKEN); anything through Caddy, which always sets
// X-Forwarded-For, is told it doesn't exist. Every request also says where the
// install is reachable (X-Public-Url), which the links in emails use.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { bearer, InputError, json, readJson, send } from "../../lib/http.ts";
import type { ApiKeys } from "./api.ts";
import type { Automations } from "./automations.ts";
import type { Brands } from "./brands.ts";
import type { Campaigns } from "./campaigns.ts";
import { checkEmail, checkFields, type Contacts, type Verdicts } from "./contacts.ts";
import { isEmail } from "./mime.ts";
import { getSetting, setSetting } from "./db.ts";
import type { Domains } from "./domains.ts";
import type { Mailer } from "./mailer.ts";
import { contactVars, renderMarketing } from "./render.ts";
import { ADDRESS_CHECKS, CHECK_LABELS, decide, type Check, type Shield } from "./shield.ts";
import { SmtpConnection } from "./smtp.ts";
import type { Templates } from "./templates.ts";

export interface Settings {
  /** Bodies of sent emails (transactional, automations) are kept this long for the logs. */
  keepBodiesDays: number;
  /** Messages and their events are kept this long. */
  keepDays: number;
}

const DEFAULTS: Settings = { keepBodiesDays: 30, keepDays: 365 };

export function readSettings(db: DatabaseSync): Settings {
  const v = getSetting(db, "owner");
  return v ? { ...DEFAULTS, ...(JSON.parse(v) as Partial<Settings>) } : { ...DEFAULTS };
}

export interface AdminContext {
  db: DatabaseSync;
  brands: Brands;
  domains: Domains;
  contacts: Contacts;
  campaigns: Campaigns;
  templates: Templates;
  automations: Automations;
  mailer: Mailer;
  keys: ApiKeys;
  shield: Shield;
  token: string;
  version: string;
  publicUrl: () => string;
  setPublicUrl: (url: string) => void;
  smtpCa?: string;
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const authorized = (req: IncomingMessage, token: string) => {
  const given = bearer(req);
  return given !== null && timingSafeEqual(digest(given), digest(token));
};

type Handler = (a: { req: IncomingMessage; res: ServerResponse; ctx: AdminContext; p: Record<string, string>; q: URLSearchParams; body: () => Promise<Record<string, unknown>> }) => Promise<unknown> | unknown;

const num = (v: string | undefined, what: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new InputError(what, `no such ${what}`, 404);
  return n;
};

/** Messages by day for a brand: sent, delivered, opened, clicked, bounced, complained, unsubscribed. */
function brandStats(db: DatabaseSync, brandId: number, days: number, now = Date.now()) {
  const DAY = 86_400_000;
  const from = Math.floor(now / DAY) * DAY - (days - 1) * DAY;
  const series = new Map<number, Record<string, number>>();
  for (let at = from; at <= now; at += DAY) series.set(at, { sent: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0, failed: 0 });
  const bucket = (column: string, key: string, extra = "") => {
    for (const r of db.prepare(`SELECT (${column} / ${DAY}) * ${DAY} d, count(*) n FROM messages WHERE brand_id = ? AND ${column} >= ? ${extra} GROUP BY d`).all(brandId, from) as { d: number; n: number }[]) {
      const p = series.get(r.d);
      if (p) p[key] = r.n;
    }
  };
  bucket("sent_at", "sent");
  bucket("opened_at", "opened");
  bucket("clicked_at", "clicked");
  bucket("unsubscribed_at", "unsubscribed");
  bucket("created_at", "bounced", "AND status = 'bounced'");
  bucket("created_at", "complained", "AND status = 'complained'");
  bucket("created_at", "failed", "AND status = 'failed'");
  const list = [...series].map(([at, v]) => ({ at, ...v }));
  const total = list.reduce((a, d) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k]! + (d as Record<string, number>)[k]!])), { sent: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0, failed: 0 } as Record<string, number>);
  return { days, from, series: list, total };
}

/** The domain a brand is known by (its website's, else its first sending domain's, verified first), for its logo; and whether it sends from a verified one. */
function brandDomain(ctx: AdminContext, brandId: number, website: string): { domain: string | null; verified: boolean } {
  const domains = ctx.domains.list(brandId);
  const verified = domains.some((d) => d.status === "verified");
  let host: string | null = null;
  try {
    host = website ? new URL(/^https?:\/\//.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, "") : null;
  } catch {
    host = null;
  }
  const first = domains.find((d) => d.status === "verified") ?? domains[0];
  return { domain: host || first?.domain || null, verified };
}

/** Shield's verdicts for many addresses, for an import or a sync: what each would do, and the counts. */
export async function shieldVerdicts(ctx: AdminContext, brandId: number, emails: string[]): Promise<{ verdicts: Verdicts; summary: ImportCheck }> {
  const settings = ctx.shield.settings(brandId);
  const found = await ctx.shield.checkMany(brandId, emails);
  const verdicts: Verdicts = new Map();
  const summary: ImportCheck = { total: found.size, ok: 0, flag: 0, refuse: 0, byCheck: {}, examples: {} };
  for (const [email, v] of found) {
    const d = decide(v, settings);
    verdicts.set(email, { outcome: d.outcome, checks: d.verdicts.map((x) => x.check), labels: d.verdicts.map((x) => CHECK_LABELS[x.check]) });
    summary[d.outcome]++;
    for (const x of d.verdicts) {
      const b = (summary.byCheck[x.check] ??= { action: x.action, count: 0 });
      b.count++;
      const ex = (summary.examples[x.check] ??= []);
      if (ex.length < 5) ex.push({ email, detail: x.detail });
    }
  }
  return { verdicts, summary };
}

export interface ImportCheck {
  /** Distinct addresses checked, and how many would come in clean, flagged or not at all. */
  total: number;
  ok: number;
  flag: number;
  refuse: number;
  byCheck: Partial<Record<Check, { action: "refuse" | "flag"; count: number }>>;
  examples: Partial<Record<Check, { email: string; detail: string }[]>>;
}

/**
 * Clean the list: the address checks on every subscribed or unconfirmed contact
 * not yet approved, in the background (DNS takes a while on a big list). The
 * result stays until the next scan, for Apply.
 */
interface Scan {
  state: "running" | "done" | "failed";
  checked: number;
  total: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  byCheck: Partial<Record<Check, number>>;
  examples: Partial<Record<Check, { email: string; detail: string }[]>>;
  /** Contact ids by check, for Apply. */
  ids: Partial<Record<Check, number[]>>;
}
const scans = new Map<number, Scan>();

function startScan(ctx: AdminContext, brandId: number): Scan {
  const running = scans.get(brandId);
  if (running?.state === "running") return running;
  const contacts = ctx.db.prepare("SELECT id, email FROM contacts WHERE brand_id = ? AND status IN ('subscribed', 'unconfirmed') AND approved = 0").all(brandId) as { id: number; email: string }[];
  const scan: Scan = { state: "running", checked: 0, total: contacts.length, startedAt: Date.now(), finishedAt: null, error: null, byCheck: {}, examples: {}, ids: {} };
  scans.set(brandId, scan);
  void (async () => {
    const settings = ctx.shield.settings(brandId);
    for (let i = 0; i < contacts.length; i += 500) {
      const chunk = contacts.slice(i, i + 500);
      const found = await ctx.shield.checkMany(brandId, chunk.map((c) => c.email));
      for (const c of chunk) {
        for (const v of found.get(c.email.toLowerCase()) ?? []) {
          if (settings.checks[v.check] === "off") continue;
          scan.byCheck[v.check] = (scan.byCheck[v.check] ?? 0) + 1;
          (scan.ids[v.check] ??= []).push(c.id);
          const ex = (scan.examples[v.check] ??= []);
          if (ex.length < 5) ex.push({ email: c.email, detail: v.detail });
        }
      }
      scan.checked += chunk.length;
    }
    scan.state = "done";
    scan.finishedAt = Date.now();
  })().catch((err: Error) => {
    scan.state = "failed";
    scan.error = err.message;
    scan.finishedAt = Date.now();
  });
  return scan;
}

const scanView = (s: Scan | undefined) => (s ? { state: s.state, checked: s.checked, total: s.total, startedAt: s.startedAt, finishedAt: s.finishedAt, error: s.error, byCheck: s.byCheck, examples: s.examples } : null);

/** The hour (0-23) a moment falls on in a time zone; the server's (UTC) when there's none. */
function hourIn(at: number, tz: string | null): number {
  if (!tz) return new Date(at).getUTCHours();
  try {
    return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(at)) % 24;
  } catch {
    return new Date(at).getUTCHours();
  }
}

const sourceKind = (s: string) => (s.startsWith("sync:") ? "sync" : ["form", "api", "import", "panel", "event"].includes(s) ? s : "other");

/**
 * A brand's Insights: where its contacts are, on what, how engaged, where they
 * came from week by week, when they click (in their own time zones), and the
 * list's health.
 */
function insights(ctx: AdminContext, brandId: number, now = Date.now()) {
  const DAY = 86_400_000;
  const db = ctx.db;
  const live = "brand_id = ? AND status IN ('subscribed', 'unconfirmed')";
  const group = (column: string, limit: number) => db.prepare(`SELECT ${column} k, count(*) n FROM contacts WHERE ${live} GROUP BY k ORDER BY n DESC LIMIT ${limit}`).all(brandId) as { k: string | null; n: number }[];
  const e = db
    .prepare(
      `SELECT count(*) total,
         sum(CASE WHEN max(coalesce(last_open_at, 0), coalesce(last_click_at, 0)) >= ? THEN 1 ELSE 0 END) active,
         sum(CASE WHEN max(coalesce(last_open_at, 0), coalesce(last_click_at, 0)) BETWEEN ? AND ? THEN 1 ELSE 0 END) cooling,
         sum(CASE WHEN max(coalesce(last_open_at, 0), coalesce(last_click_at, 0)) BETWEEN 1 AND ? THEN 1 ELSE 0 END) inactive
       FROM contacts WHERE brand_id = ? AND status = 'subscribed'`,
    )
    .get(now - 30 * DAY, now - 90 * DAY, now - 30 * DAY - 1, now - 90 * DAY - 1, brandId) as { total: number; active: number | null; cooling: number | null; inactive: number | null };
  const engagement = { active: e.active ?? 0, cooling: e.cooling ?? 0, inactive: e.inactive ?? 0, none: e.total - (e.active ?? 0) - (e.cooling ?? 0) - (e.inactive ?? 0) };

  // New contacts by week and source, over 12 weeks.
  const WEEK = 7 * DAY;
  const from = Math.floor(now / WEEK) * WEEK - 11 * WEEK;
  const weeks = Array.from({ length: 12 }, (_, i) => ({ at: from + i * WEEK, form: 0, sync: 0, api: 0, import: 0, panel: 0, event: 0, other: 0 }));
  for (const r of db.prepare(`SELECT created_at at, source FROM contacts WHERE brand_id = ? AND created_at >= ?`).all(brandId, from) as { at: number; source: string }[]) {
    const w = weeks[Math.floor((r.at - from) / WEEK)];
    if (w) w[sourceKind(r.source) as "form"]++;
  }

  // Clicks by hour in each contact's own time zone, over 90 days.
  const hours = Array.from({ length: 24 }, () => 0);
  const clicks = db
    .prepare(`SELECT e.at, c.timezone FROM events e JOIN messages m ON m.id = e.message_id JOIN contacts c ON c.id = m.contact_id WHERE m.brand_id = ? AND e.kind = 'click' AND e.at >= ? LIMIT 200000`)
    .all(brandId, now - 90 * DAY) as { at: number; timezone: string | null }[];
  for (const c of clicks) hours[hourIn(c.at, c.timezone)]!++;
  const withZone = clicks.filter((c) => c.timezone).length;

  const m = db
    .prepare(`SELECT count(*) sent, sum(status = 'bounced') bounced, sum(status = 'complained') complained FROM messages WHERE brand_id = ? AND sent_at >= ? AND kind IN ('campaign', 'automation', 'transactional')`)
    .get(brandId, now - 30 * DAY) as { sent: number; bounced: number | null; complained: number | null };
  const counts = ctx.contacts.counts(brandId);
  return {
    contacts: counts.subscribed + counts.unconfirmed,
    countries: group("country", 30),
    devices: group("device", 10),
    clients: group("client", 10),
    engagement,
    growth: weeks,
    hours,
    clicks: { total: clicks.length, withZone },
    health: { flagged: counts.flagged, sent30d: m.sent, bounced30d: m.bounced ?? 0, complained30d: m.complained ?? 0, shield: ctx.shield.stats(brandId, 30) },
  };
}

const ROUTES: [string, string, Handler][] = [
  ["GET", "info", ({ ctx }) => ({ version: ctx.version, publicUrl: ctx.publicUrl(), brands: ctx.brands.list().length, queue: ctx.db.prepare("SELECT count(*) queued FROM messages WHERE status IN ('queued', 'sending')").get() })],
  ["GET", "settings", ({ ctx }) => readSettings(ctx.db)],
  [
    "PUT",
    "settings",
    async ({ ctx, body }) => {
      const input = await body();
      const next = readSettings(ctx.db);
      for (const [key, max] of [["keepBodiesDays", 365], ["keepDays", 3650]] as const) {
        if (input[key] === undefined) continue;
        const n = Number(input[key]);
        if (!Number.isInteger(n) || n < 1 || n > max) throw new InputError(key, `must be 1 to ${max} days`);
        next[key] = n;
      }
      setSetting(ctx.db, "owner", JSON.stringify(next));
      return next;
    },
  ],

  // Brands
  [
    "GET",
    "brands",
    ({ ctx }) => ({
      brands: ctx.brands.list().map((b) => ({
        ...b,
        contacts: ctx.contacts.counts(b.id).subscribed,
        sent30d: (ctx.db.prepare("SELECT count(*) n FROM messages WHERE brand_id = ? AND sent_at >= ?").get(b.id, Date.now() - 30 * 86_400_000) as { n: number }).n,
        ...brandDomain(ctx, b.id, b.website),
      })),
    }),
  ],
  ["POST", "brands", async ({ ctx, body }) => ctx.brands.add(await body())],
  [
    "GET",
    "brands/:b",
    ({ ctx, p, q }) => {
      const b = ctx.brands.must(num(p.b, "brand"));
      const days = Math.min(90, Math.max(1, Number(q.get("days")) || 30));
      return { brand: b, contacts: ctx.contacts.counts(b.id), stats: brandStats(ctx.db, b.id, days), domains: ctx.domains.list(b.id), campaigns: ctx.campaigns.list(b.id).slice(0, 5) };
    },
  ],
  ["PATCH", "brands/:b", async ({ ctx, p, body }) => ctx.brands.update(num(p.b, "brand"), await body())],
  ["DELETE", "brands/:b", ({ ctx, p }) => (ctx.brands.remove(num(p.b, "brand")), { deleted: true })],
  ["PUT", "brands/:b/provider", async ({ ctx, p, body }) => ctx.brands.setProvider(num(p.b, "brand"), await body())],
  [
    "POST",
    "brands/:b/provider/check",
    async ({ ctx, p }) => {
      const b = ctx.brands.must(num(p.b, "brand"));
      if (b.provider === "ses") return { ok: true, ses: await ctx.brands.ses(b.id).account() };
      if (b.provider === "smtp") {
        // Connects and logs in, sending nothing.
        const c = await SmtpConnection.open(ctx.brands.smtpConfig(b.id), { name: new URL(ctx.publicUrl()).hostname, ca: ctx.smtpCa }).catch((err: Error) => {
          throw new InputError("provider", err.message, 502);
        });
        await c.close();
        return { ok: true, smtp: { extensions: [...c.extensions] } };
      }
      throw new InputError("provider", "this brand has no provider yet", 409);
    },
  ],
  [
    "POST",
    "brands/:b/provider/test",
    async ({ ctx, p, body }) => {
      const b = ctx.brands.must(num(p.b, "brand"));
      const input = await body();
      const to = checkEmail(input.to, "to");
      const from = typeof input.from === "string" && input.from ? input.from : b.fromName ? `${b.fromName} <${b.fromEmail}>` : b.fromEmail;
      if (!from) throw new InputError("from", "the brand has no From address: set it first");
      const id = ctx.mailer.queue({
        brandId: b.id,
        kind: "test",
        payload: { from, to: [to], subject: `A test from ${b.name}`, text: `This is a test email from ${b.name}, sent with Self Host Layer's Email through ${b.provider === "ses" ? "Amazon SES" : `${b.smtp?.host}:${b.smtp?.port}`}.\n\nIf you can read this, sending works.`, html: `<p>This is a test email from <b>${b.name.replace(/[<>&]/g, "")}</b>, sent with Self Host Layer's Email.</p><p>If you can read this, sending works.</p>` },
      });
      return ctx.mailer.sendNow(id);
    },
  ],
  [
    "POST",
    "brands/:b/ses-events",
    async ({ ctx, p }) => {
      const b = ctx.brands.must(num(p.b, "brand"));
      const r = await ctx.brands.ses(b.id).setUpEvents({ name: `self-host-layer-${b.id}`, endpoint: `${ctx.publicUrl()}/webhooks/ses` });
      ctx.brands.setSesEvents(b.id, r);
      return ctx.brands.get(b.id);
    },
  ],
  ["GET", "brands/:b/insights", ({ ctx, p }) => insights(ctx, ctx.brands.must(num(p.b, "brand")).id)],
  ["GET", "brands/:b/stats", ({ ctx, p, q }) => brandStats(ctx.db, ctx.brands.must(num(p.b, "brand")).id, Math.min(90, Math.max(1, Number(q.get("days")) || 30)))],

  // Domains
  ["GET", "brands/:b/domains", ({ ctx, p }) => ({ domains: ctx.domains.list(ctx.brands.must(num(p.b, "brand")).id) })],
  ["POST", "brands/:b/domains", async ({ ctx, p, body }) => ctx.domains.add(num(p.b, "brand"), (await body()).domain)],
  ["POST", "brands/:b/domains/:id/verify", ({ ctx, p }) => ctx.domains.verify(num(p.b, "brand"), num(p.id, "domain"))],
  ["DELETE", "brands/:b/domains/:id", async ({ ctx, p }) => (await ctx.domains.remove(num(p.b, "brand"), num(p.id, "domain")), { deleted: true })],

  // Lists
  ["GET", "brands/:b/lists", ({ ctx, p }) => ({ lists: ctx.contacts.lists(ctx.brands.must(num(p.b, "brand")).id) })],
  ["POST", "brands/:b/lists", async ({ ctx, p, body }) => ctx.contacts.addList(ctx.brands.must(num(p.b, "brand")).id, await body())],
  ["PATCH", "brands/:b/lists/:id", async ({ ctx, p, body }) => ctx.contacts.updateList(num(p.b, "brand"), num(p.id, "list"), await body())],
  ["DELETE", "brands/:b/lists/:id", ({ ctx, p }) => (ctx.contacts.removeList(num(p.b, "brand"), num(p.id, "list")), { deleted: true })],

  // Contacts
  [
    "GET",
    "brands/:b/contacts",
    ({ ctx, p, q }) => ctx.contacts.search(ctx.brands.must(num(p.b, "brand")).id, { q: q.get("q") ?? undefined, list: Number(q.get("list")) || undefined, status: q.get("status") ?? undefined, page: Number(q.get("page")) || 1 }),
  ],
  ["POST", "brands/:b/contacts", async ({ ctx, p, body }) => ctx.contacts.upsert(ctx.brands.must(num(p.b, "brand")).id, await body(), { resubscribe: true, source: "panel" })],
  [
    "GET",
    "brands/:b/contacts/:id",
    ({ ctx, p }) => {
      const b = num(p.b, "brand");
      const c = ctx.contacts.get(b, num(p.id, "contact"));
      const messages = ctx.db
        .prepare(
          `SELECT m.id, m.kind, m.subject, m.status, m.created_at createdAt, m.sent_at sentAt, m.opened_at openedAt, m.clicked_at clickedAt, m.campaign_id campaignId, c.name campaign
           FROM messages m LEFT JOIN campaigns c ON c.id = m.campaign_id WHERE m.brand_id = ? AND (m.contact_id = ? OR m.to_email = ?) ORDER BY m.created_at DESC LIMIT 100`,
        )
        .all(b, c.id, c.email);
      // Its opens and clicks, newest first, for the contact's timeline.
      const activity = ctx.db
        .prepare(
          `SELECT e.at, e.kind, e.detail, m.subject, m.campaign_id campaignId FROM events e JOIN messages m ON m.id = e.message_id
           WHERE m.brand_id = ? AND (m.contact_id = ? OR m.to_email = ?) AND e.kind IN ('open', 'click', 'unsubscribe', 'bounce', 'complaint') ORDER BY e.at DESC LIMIT 100`,
        )
        .all(b, c.id, c.email);
      return { contact: c, messages, activity, suppressed: ctx.contacts.isSuppressed(b, c.email) };
    },
  ],
  ["PATCH", "brands/:b/contacts/:id", async ({ ctx, p, body }) => ctx.contacts.update(num(p.b, "brand"), num(p.id, "contact"), await body())],
  ["POST", "brands/:b/contacts/:id/approve", ({ ctx, p }) => ctx.contacts.approve(num(p.b, "brand"), num(p.id, "contact"))],
  ["DELETE", "brands/:b/contacts/:id", ({ ctx, p }) => (ctx.contacts.remove(num(p.b, "brand"), num(p.id, "contact")), { deleted: true })],
  ["POST", "brands/:b/contacts/:id/lists", async ({ ctx, p, body }) => ({ added: ctx.contacts.addToList(num(p.b, "brand"), num(p.id, "contact"), Number((await body()).listId)) })],
  ["DELETE", "brands/:b/contacts/:id/lists/:list", ({ ctx, p }) => (ctx.contacts.removeFromList(num(p.b, "brand"), num(p.id, "contact"), num(p.list, "list")), { removed: true })],
  [
    "POST",
    "brands/:b/import",
    async ({ ctx, p, req }) => {
      const b = ctx.brands.must(num(p.b, "brand")).id;
      const input = await readJson(req, 60 * 1024 * 1024);
      if (typeof input.csv !== "string") throw new InputError("csv", "must be the file's text");
      // Shield's address checks, unless asked not to; include: "flagged" lets refused ones in, flagged.
      if (input.shield === false) return ctx.contacts.importCsv(b, input.csv, { lists: input.lists, status: input.status });
      const parsed = ctx.contacts.parseCsv(input.csv);
      const { verdicts } = await shieldVerdicts(ctx, b, parsed.rows.map((r) => r.email));
      if (input.include === "flagged") for (const v of verdicts.values()) if (v.outcome === "refuse") v.outcome = "flag";
      const r = ctx.contacts.importRows(b, parsed, { lists: input.lists, status: input.status, verdicts, source: "import" });
      for (const v of verdicts.values()) ctx.shield.log(b, v.outcome, v.checks, "import");
      return r;
    },
  ],
  [
    // A page of rows from one of the panel's projects (Sync from an app): Shield's address checks, then in like an import.
    "POST",
    "brands/:b/sync",
    async ({ ctx, p, req }) => {
      const b = ctx.brands.must(num(p.b, "brand")).id;
      const input = await readJson(req, 8 * 1024 * 1024);
      if (!Array.isArray(input.rows) || input.rows.length > 5000) throw new InputError("rows", "must be a list of at most 5,000 rows");
      const source = typeof input.source === "string" && /^sync:[a-z0-9-]{1,63}$/.test(input.source) ? input.source : "sync";
      const parsed = { rows: [] as { line: number; email: string; name: string; fields: Record<string, string> }[], skipped: [] as { line: number; reason: string }[] };
      input.rows.forEach((raw: unknown, i: number) => {
        const r = (raw ?? {}) as Record<string, unknown>;
        const email = typeof r.email === "string" ? r.email.trim().toLowerCase() : "";
        if (!isEmail(email)) return void parsed.skipped.push({ line: i + 1, reason: email ? `${email.slice(0, 80)} isn't an email address` : "no email" });
        let fields: Record<string, string> = {};
        try {
          fields = checkFields(r.fields);
        } catch {
          fields = {};
        }
        parsed.rows.push({ line: i + 1, email, name: typeof r.name === "string" ? r.name.trim().replace(/[\r\n]+/g, " ").slice(0, 200) : "", fields });
      });
      const { verdicts } = await shieldVerdicts(ctx, b, parsed.rows.map((r) => r.email));
      for (const v of verdicts.values()) ctx.shield.log(b, v.outcome, v.checks, "sync");
      // Subscribed: they signed up on the brand's own site. Nobody who left comes back.
      return ctx.contacts.importRows(b, parsed, { lists: input.lists, verdicts, source });
    },
  ],
  [
    // What Shield would make of an import, before anything is added.
    "POST",
    "brands/:b/import/check",
    async ({ ctx, p, req }) => {
      const b = ctx.brands.must(num(p.b, "brand")).id;
      const input = await readJson(req, 60 * 1024 * 1024);
      if (typeof input.csv !== "string") throw new InputError("csv", "must be the file's text");
      const parsed = ctx.contacts.parseCsv(input.csv);
      const { summary } = await shieldVerdicts(ctx, b, parsed.rows.map((r) => r.email));
      return { ...summary, rows: parsed.rows.length, skipped: parsed.skipped.slice(0, 50), unreadable: parsed.skipped.length };
    },
  ],
  [
    "GET",
    "brands/:b/export",
    ({ ctx, p, q, res }) => {
      const b = ctx.brands.must(num(p.b, "brand")).id;
      send(res, 200, ctx.contacts.exportCsv(b, { list: Number(q.get("list")) || undefined, status: q.get("status") ?? undefined }), { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" });
      return undefined;
    },
  ],
  ["GET", "brands/:b/suppressions", ({ ctx, p, q }) => ctx.contacts.suppressions(ctx.brands.must(num(p.b, "brand")).id, Number(q.get("page")) || 1)],
  ["POST", "brands/:b/suppressions", async ({ ctx, p, body }) => (ctx.contacts.suppress(ctx.brands.must(num(p.b, "brand")).id, checkEmail((await body()).email), "manual", "added by hand"), { suppressed: true })],
  ["DELETE", "brands/:b/suppressions/:email", ({ ctx, p }) => (ctx.contacts.unsuppress(num(p.b, "brand"), decodeURIComponent(p.email!)), { deleted: true })],

  // Shield
  [
    "GET",
    "brands/:b/shield",
    ({ ctx, p, q }) => {
      const b = ctx.brands.must(num(p.b, "brand")).id;
      return { settings: ctx.shield.settings(b), lists: ctx.shield.lists(), abuseipdb: ctx.shield.hasAbuseKey(), stats: ctx.shield.stats(b, Math.min(90, Math.max(1, Number(q.get("days")) || 30))), flagged: ctx.contacts.counts(b).flagged, scan: scanView(scans.get(b)) };
    },
  ],
  ["PUT", "brands/:b/shield", async ({ ctx, p, body }) => ctx.shield.setSettings(ctx.brands.must(num(p.b, "brand")).id, await body())],
  ["PUT", "shield/abuseipdb", async ({ ctx, body }) => (ctx.shield.setAbuseKey((await body()).key), { abuseipdb: ctx.shield.hasAbuseKey() })],
  ["POST", "shield/refresh", async ({ ctx }) => (await ctx.shield.refresh(true), { lists: ctx.shield.lists() })],
  ["POST", "brands/:b/shield/scan", ({ ctx, p }) => scanView(startScan(ctx, ctx.brands.must(num(p.b, "brand")).id))],
  [
    "POST",
    "brands/:b/shield/scan/apply",
    async ({ ctx, p, body }) => {
      const b = ctx.brands.must(num(p.b, "brand")).id;
      const scan = scans.get(b);
      if (scan?.state !== "done") throw new InputError("scan", "run Clean the list first, and wait for it to finish", 409);
      const input = await body();
      const action = input.action === "unsubscribe" ? "unsubscribe" : "flag";
      const checks = Array.isArray(input.checks) ? (input.checks.filter((c) => (ADDRESS_CHECKS as unknown[]).includes(c)) as Check[]) : [];
      if (!checks.length) throw new InputError("checks", "pick at least one check");
      const byContact = new Map<number, string[]>();
      for (const c of checks) for (const id of scan.ids[c] ?? []) byContact.set(id, [...(byContact.get(id) ?? []), c]);
      const changed = ctx.contacts.applyFlags(b, byContact, action);
      scans.delete(b);
      return { changed, action };
    },
  ],

  // Campaigns
  ["GET", "brands/:b/campaigns", ({ ctx, p }) => ({ campaigns: ctx.campaigns.list(ctx.brands.must(num(p.b, "brand")).id) })],
  ["POST", "brands/:b/campaigns", async ({ ctx, p, body }) => ctx.campaigns.add(num(p.b, "brand"), await body())],
  [
    "GET",
    "brands/:b/campaigns/:id",
    ({ ctx, p }) => {
      const c = ctx.campaigns.get(num(p.b, "brand"), num(p.id, "campaign"));
      return { campaign: c, links: ctx.campaigns.links(c.brandId, c.id), audience: c.status === "draft" || c.status === "scheduled" ? ctx.campaigns.audience(c.brandId, c.lists, c.excludeLists) : c.stats.recipients, problems: c.status === "draft" || c.status === "scheduled" ? ctx.campaigns.problems(c) : [] };
    },
  ],
  ["PATCH", "brands/:b/campaigns/:id", async ({ ctx, p, body }) => ctx.campaigns.update(num(p.b, "brand"), num(p.id, "campaign"), await body())],
  ["DELETE", "brands/:b/campaigns/:id", ({ ctx, p }) => (ctx.campaigns.remove(num(p.b, "brand"), num(p.id, "campaign")), { deleted: true })],
  ["POST", "brands/:b/campaigns/:id/duplicate", ({ ctx, p }) => ctx.campaigns.duplicate(num(p.b, "brand"), num(p.id, "campaign"))],
  [
    "POST",
    "brands/:b/campaigns/:id/schedule",
    async ({ ctx, p, body }) => {
      const at = (await body()).at;
      return ctx.campaigns.schedule(num(p.b, "brand"), num(p.id, "campaign"), at === undefined || at === null || at === "" ? null : typeof at === "number" ? at : Date.parse(String(at)));
    },
  ],
  ["POST", "brands/:b/campaigns/:id/unschedule", ({ ctx, p }) => ctx.campaigns.unschedule(num(p.b, "brand"), num(p.id, "campaign"))],
  ["POST", "brands/:b/campaigns/:id/pause", ({ ctx, p }) => ctx.campaigns.pause(num(p.b, "brand"), num(p.id, "campaign"))],
  ["POST", "brands/:b/campaigns/:id/resume", ({ ctx, p }) => ctx.campaigns.resume(num(p.b, "brand"), num(p.id, "campaign"))],
  ["POST", "brands/:b/campaigns/:id/cancel", ({ ctx, p }) => ctx.campaigns.cancel(num(p.b, "brand"), num(p.id, "campaign"))],
  [
    "POST",
    "brands/:b/campaigns/:id/test",
    async ({ ctx, p, body }) => {
      const c = ctx.campaigns.get(num(p.b, "brand"), num(p.id, "campaign"));
      const to = checkEmail((await body()).to, "to");
      if (!c.subject || !c.html) throw new InputError("campaign", "it needs a subject and content first");
      const brand = ctx.brands.must(c.brandId);
      const sample = ctx.contacts.byEmail(c.brandId, to) ?? { email: to, name: "", fields: {} };
      const id = ctx.mailer.queueMarketing({
        brandId: c.brandId,
        kind: "test",
        contact: { id: 0, email: to, name: sample.name, fields: sample.fields },
        from: c.fromName ? `${c.fromName} <${c.fromEmail || brand.fromEmail}>` : c.fromEmail || brand.fromEmail,
        replyTo: c.replyTo || undefined,
        subject: `[Test] ${c.subject}`,
        preheader: c.preheader,
        html: c.html,
        text: c.text,
      });
      return ctx.mailer.sendNow(id);
    },
  ],
  [
    "GET",
    "brands/:b/audience",
    ({ ctx, p, q }) => {
      const b = ctx.brands.must(num(p.b, "brand")).id;
      const ids = (k: string) => (q.get(k) ?? "").split(",").filter(Boolean).map(Number);
      return { count: ctx.campaigns.audience(b, ids("lists"), ids("exclude")) };
    },
  ],
  [
    "POST",
    "brands/:b/preview",
    async ({ ctx, p, body }) => {
      // The campaign as a contact would see it, without tracking: for the editor's preview.
      const brand = ctx.brands.must(num(p.b, "brand"));
      const input = await body();
      const html = typeof input.html === "string" ? input.html : "";
      const r = renderMarketing({ subject: String(input.subject ?? ""), html, text: "", preheader: String(input.preheader ?? ""), vars: contactVars({ email: "ada@example.com", name: "Ada Lovelace", fields: {} }), brand: { ...brand, trackOpens: false, trackClicks: false }, unsubscribeUrl: "#unsubscribe", openUrl: "", clickUrl: (u) => u });
      return r;
    },
  ],

  // Templates
  ["GET", "brands/:b/templates", ({ ctx, p }) => ({ templates: ctx.templates.list(ctx.brands.must(num(p.b, "brand")).id) })],
  ["POST", "brands/:b/templates", async ({ ctx, p, body }) => ctx.templates.add(ctx.brands.must(num(p.b, "brand")).id, await body())],
  ["GET", "brands/:b/templates/:id", ({ ctx, p }) => ctx.templates.get(num(p.b, "brand"), num(p.id, "template"))],
  ["PATCH", "brands/:b/templates/:id", async ({ ctx, p, body }) => ctx.templates.update(num(p.b, "brand"), num(p.id, "template"), await body())],
  ["DELETE", "brands/:b/templates/:id", ({ ctx, p }) => (ctx.templates.remove(num(p.b, "brand"), num(p.id, "template")), { deleted: true })],

  // Automations
  ["GET", "brands/:b/automations", ({ ctx, p }) => ({ automations: ctx.automations.list(ctx.brands.must(num(p.b, "brand")).id) })],
  ["POST", "brands/:b/automations", async ({ ctx, p, body }) => ctx.automations.add(num(p.b, "brand"), await body())],
  ["GET", "brands/:b/automations/:id", ({ ctx, p, q }) => ({ automation: ctx.automations.get(num(p.b, "brand"), num(p.id, "automation")), ...ctx.automations.runs(num(p.b, "brand"), num(p.id, "automation"), Number(q.get("page")) || 1) })],
  ["PATCH", "brands/:b/automations/:id", async ({ ctx, p, body }) => ctx.automations.update(num(p.b, "brand"), num(p.id, "automation"), await body())],
  ["POST", "brands/:b/automations/:id/status", async ({ ctx, p, body }) => ctx.automations.setStatus(num(p.b, "brand"), num(p.id, "automation"), (await body()).status)],
  ["DELETE", "brands/:b/automations/:id", ({ ctx, p }) => (ctx.automations.remove(num(p.b, "brand"), num(p.id, "automation")), { deleted: true })],

  // API keys
  ["GET", "brands/:b/keys", ({ ctx, p }) => ({ keys: ctx.keys.list(ctx.brands.must(num(p.b, "brand")).id) })],
  ["POST", "brands/:b/keys", async ({ ctx, p, body }) => ctx.keys.create(ctx.brands.must(num(p.b, "brand")).id, (await body()).name)],
  ["DELETE", "brands/:b/keys/:id", ({ ctx, p }) => (ctx.keys.revoke(num(p.b, "brand"), num(p.id, "key")), { deleted: true })],

  // Logs
  [
    "GET",
    "brands/:b/messages",
    ({ ctx, p, q }) => {
      const b = ctx.brands.must(num(p.b, "brand")).id;
      const parts = ["brand_id = ?"];
      const args: (string | number)[] = [b];
      const kind = q.get("kind");
      if (kind && ["campaign", "transactional", "automation", "test", "confirm"].includes(kind)) {
        parts.push("kind = ?");
        args.push(kind);
      }
      const status = q.get("status");
      if (status) {
        parts.push("status = ?");
        args.push(status);
      }
      const search = q.get("q")?.trim();
      if (search) {
        parts.push("(to_email LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\' OR id = ?)");
        const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        args.push(like, like, search);
      }
      const where = parts.join(" AND ");
      const total = (ctx.db.prepare(`SELECT count(*) n FROM messages WHERE ${where}`).get(...args) as { n: number }).n;
      const page = Math.max(1, Number(q.get("page")) || 1);
      const messages = ctx.db
        .prepare(`SELECT id, kind, to_email "to", from_email "from", subject, status, error, created_at createdAt, send_at sendAt, sent_at sentAt, opened_at openedAt, clicked_at clickedAt, opens, clicks FROM messages WHERE ${where} ORDER BY created_at DESC LIMIT 50 OFFSET ${(page - 1) * 50}`)
        .all(...args);
      return { messages, total, page, pageSize: 50 };
    },
  ],
  [
    "GET",
    "brands/:b/messages/:id",
    ({ ctx, p }) => {
      const b = ctx.brands.must(num(p.b, "brand")).id;
      const m = ctx.db.prepare("SELECT * FROM messages WHERE id = ? AND brand_id = ?").get(p.id!, b) as Record<string, unknown> | undefined;
      if (!m) throw new InputError("message", "no such message", 404);
      const body = ctx.db.prepare("SELECT payload FROM message_bodies WHERE message_id = ?").get(p.id!) as { payload: string } | undefined;
      const payload = body ? JSON.parse(body.payload) : null;
      if (payload?.attachments) payload.attachments = payload.attachments.map((a: { filename: string; contentType: string; content: string }) => ({ filename: a.filename, contentType: a.contentType, bytes: Math.floor((a.content.length * 3) / 4) }));
      return { message: m, payload, events: ctx.db.prepare("SELECT at, kind, detail FROM events WHERE message_id = ? ORDER BY at, rowid").all(p.id!) };
    },
  ],
];

export async function handleAdmin(req: IncomingMessage, res: ServerResponse, ctx: AdminContext, url: URL): Promise<void> {
  if (req.headers["x-forwarded-for"] !== undefined) return json(res, 404, { error: "not found" });
  if (!authorized(req, ctx.token)) return json(res, 401, { error: "the admin token is missing or wrong" });
  const told = req.headers["x-public-url"];
  if (typeof told === "string" && /^https?:\/\/[^\s/]+$/.test(told) && told !== ctx.publicUrl()) ctx.setPublicUrl(told);
  const parts = url.pathname.split("/").slice(2).filter(Boolean);
  for (const [method, pattern, handler] of ROUTES) {
    if (method !== (req.method ?? "GET")) continue;
    const want = pattern.split("/");
    if (want.length !== parts.length) continue;
    const p: Record<string, string> = {};
    if (!want.every((w, i) => (w.startsWith(":") ? ((p[w.slice(1)] = decodeURIComponent(parts[i]!)), true) : w === parts[i]))) continue;
    const out = await handler({ req, res, ctx, p, q: url.searchParams, body: () => readJson(req, 4 * 1024 * 1024) });
    if (!res.headersSent) json(res, 200, out ?? {});
    return;
  }
  json(res, 404, { error: "not found" });
}

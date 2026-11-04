// What anyone may reach on the install's public address, besides the API:
//   GET  /t/o/<id>.gif          an open (a 1×1 GIF)
//   GET  /t/c/<id>?u=…&s=…      a click: counted, then off to the link (signed, so no open redirect)
//   GET  /u/<id>.<sig>          unsubscribe: asks first
//   POST /u/<id>.<sig>          unsubscribes (the button, or RFC 8058's one-click from the inbox)
//   POST /subscribe/<list key>  a site's signup form (form or JSON), with double opt-in when the list has it
//   GET  /subscribe.js          the optional form snippet: Shield's honeypot, timing and time zone
//   GET  /confirm/<token>       the double opt-in link: asks first (mail scanners open every link)
//   POST /confirm/<token>       confirms, or brings back someone who unsubscribed and asked to rejoin
//   POST /webhooks/ses          SNS: SES's bounces, complaints and deliveries, signature checked
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { clientIp } from "../../lib/geo.ts";
import { html, InputError, json, readBody, send } from "../../lib/http.ts";
import { Limiter, limitKey } from "../../lib/limit.ts";
import type { Brands } from "./brands.ts";
import { checkEmail, type Contacts } from "./contacts.ts";
import type { Domains } from "./domains.ts";
import type { Mailer } from "./mailer.ts";
import { escapeHtml } from "./render.ts";
import { decide, type Shield } from "./shield.ts";
import { readAgent } from "../../lib/ua.ts";
import type { Secrets } from "../../lib/secrets.ts";
import { verifySns, type SnsMessage } from "./ses.ts";

export interface PublicContext {
  db: DatabaseSync;
  brands: Brands;
  domains: Domains;
  contacts: Contacts;
  mailer: Mailer;
  secrets: Secrets;
  shield: Shield;
  /** A visitor's country from their IP, in memory (DB-IP's list). */
  country: (ip: string | null) => string | null;
  publicUrl: () => string;
  fetch?: typeof fetch;
  /** SNS's signing certificate in tests, instead of fetching it. */
  snsCertificate?: string;
  /** Signups from one address a minute (IPv6 by its /64), and confirmation emails: one an address a day. */
  limits: { signups: Limiter; confirmations: Limiter };
}

export const publicLimits = () => ({ signups: new Limiter(10, 60_000), confirmations: new Limiter(1, DAY) });

const DAY = 86_400_000;
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const MAX_EVENTS = 20;

/** A small page in the visitor's language of plain words: a title, a line, maybe a button. */
function page(res: ServerResponse, status: number, title: string, body: string, button?: { label: string; action: string }): void {
  html(
    res,
    status,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f6f6;color:#171717;font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif}main{max-width:420px;margin:24px;padding:32px;background:#fff;border:1px solid #e5e5e5;text-align:center}h1{margin:0 0 8px;font-size:20px}p{margin:0;color:#525252}button{margin-top:20px;padding:10px 18px;border:0;background:#171717;color:#fff;font:inherit;cursor:pointer}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${body}</p>${button ? `<form method="post" action="${escapeHtml(button.action)}"><button type="submit">${escapeHtml(button.label)}</button></form>` : ""}</main></body></html>`,
  );
}

/** How long the link that brings back someone who unsubscribed works. */
const REJOIN_MS = 7 * DAY;

/** Where a signup form may send people after: the brand's site or sending domain, or the site the form is on. */
function redirectTo(value: unknown, req: IncomingMessage, brand: { website: string; fromEmail: string }): string | undefined {
  if (typeof value !== "string" || !/^https?:\/\/\S+$/.test(value) || !URL.canParse(value)) return undefined;
  const host = new URL(value).hostname;
  const sites = [brand.website, req.headers.origin, req.headers.referer]
    .filter((u): u is string => typeof u === "string" && URL.canParse(u))
    .map((u) => new URL(u).hostname)
    .concat(brand.fromEmail.split("@")[1] ?? [])
    .map((h) => h.toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);
  return sites.some((s) => host === s || host.endsWith(`.${s}`)) ? value : undefined;
}

/**
 * The form snippet (<script src=".../subscribe.js" defer>): every form posting to
 * /subscribe/ gets a hidden honeypot field, and on submit how long the page was
 * open, whether a script drives the browser, and the visitor's time zone.
 */
const SNIPPET = `(function () {
  var t0 = Date.now();
  function field(f, name, value) {
    var i = f.querySelector('input[name="' + name + '"]');
    if (!i) { i = document.createElement("input"); i.type = "hidden"; i.name = name; f.appendChild(i); }
    i.value = value;
  }
  function setup() {
    document.querySelectorAll('form[action*="/subscribe/"]').forEach(function (f) {
      if (!f.querySelector('input[name="_hp"]')) {
        var hp = document.createElement("input");
        hp.name = "_hp"; hp.tabIndex = -1; hp.autocomplete = "off"; hp.setAttribute("aria-hidden", "true");
        hp.style.cssText = "position:absolute;left:-9999px;width:1px;height:1px;opacity:0";
        f.appendChild(hp);
      }
      f.addEventListener("submit", function () {
        field(f, "_el", String(Date.now() - t0));
        field(f, "_wd", String(!!navigator.webdriver));
        try { field(f, "_tz", Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (e) {}
      });
    });
  }
  if (document.readyState !== "loading") setup(); else document.addEventListener("DOMContentLoaded", setup);
})();
`;

/** An IANA time zone this Node knows (Europe/Berlin), from the form snippet. */
function validTimeZone(tz: string): boolean {
  if (tz.length > 64 || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function form(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBody(req, 64 * 1024)).toString("utf8");
  if (String(req.headers["content-type"] ?? "").includes("application/json")) {
    try {
      const v = JSON.parse(raw) as unknown;
      if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // answered below
    }
    throw new InputError("body", "must be a JSON object");
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function recordOpen(ctx: PublicContext, id: string, now: number, req?: IncomingMessage): boolean {
  const r = ctx.db.prepare("UPDATE messages SET opens = opens + 1, opened_at = coalesce(opened_at, ?) WHERE id = ? AND status IN ('sent', 'delivered') RETURNING opens").get(now, id) as { opens: number } | undefined;
  if (r && r.opens <= MAX_EVENTS) ctx.mailer.event(id, "open", undefined, now);
  if (r && req) enrich(ctx, id, "open", req, now);
  return r !== undefined;
}

/**
 * How an open reached us. Gmail and Yahoo fetch images through their own
 * proxies, so the IP and User-Agent are theirs, not the reader's; Apple Mail
 * Privacy Protection fetches them too, often without anyone reading. Those
 * are counted but tell nothing about the reader.
 */
export function openSource(ua: string | undefined): "proxy" | "apple" | "direct" {
  const s = ua ?? "";
  if (/GoogleImageProxy|ggpht\.com|YahooMailProxy/i.test(s)) return "proxy";
  if (s.trim() === "Mozilla/5.0") return "apple";
  return "direct";
}

/** The reader's email app from an open's User-Agent, or their browser from a click's. */
export function readerApp(ua: string | undefined): { device: string; client: string } | null {
  const a = readAgent(ua);
  if (a.bot) return null;
  const s = ua ?? "";
  const app = /Microsoft Outlook|ms-office|MSOffice/i.test(s) ? "Outlook" : /Thunderbird/i.test(s) ? "Thunderbird" : /AppleWebKit/.test(s) && !/Safari|Chrome|Firefox/.test(s) && /Mac OS X|iPhone|iPad/.test(s) ? "Apple Mail" : a.browser;
  return { device: a.device, client: `${app} on ${a.os}` };
}

/** What an open or click tells about its contact: counts, when, and (from the reader's own device) where and on what. Never the IP. */
function enrich(ctx: PublicContext, messageId: string, kind: "open" | "click", req: IncomingMessage, now: number): void {
  const m = ctx.db.prepare("SELECT contact_id FROM messages WHERE id = ?").get(messageId) as { contact_id: number | null } | undefined;
  if (!m?.contact_id) return;
  const ua = req.headers["user-agent"];
  const source = kind === "click" ? "direct" : openSource(ua);
  const reader = source === "direct" ? readerApp(ua) : null;
  const country = reader ? ctx.country(clientIp(req)) : null;
  if (kind === "open") {
    // Apple's automatic opens don't make anyone active.
    ctx.db
      .prepare("UPDATE contacts SET opens = opens + 1, last_open_at = CASE WHEN ? THEN last_open_at ELSE ? END, country = coalesce(?, country), device = coalesce(?, device), client = coalesce(?, client) WHERE id = ?")
      .run(source === "apple" ? 1 : 0, now, country, reader?.device ?? null, reader?.client ?? null, m.contact_id);
  } else {
    ctx.db.prepare("UPDATE contacts SET clicks = clicks + 1, last_click_at = ?, country = coalesce(?, country), device = coalesce(?, device), client = coalesce(?, client) WHERE id = ?").run(now, country, reader?.device ?? null, reader?.client ?? null, m.contact_id);
  }
}

/** Handles the public routes; false when the path isn't one of them. */
export async function handlePublic(req: IncomingMessage, res: ServerResponse, ctx: PublicContext, url: URL): Promise<boolean> {
  const p = url.pathname;
  const now = Date.now();

  if (p === "/subscribe.js" && (req.method === "GET" || req.method === "HEAD")) {
    send(res, 200, SNIPPET, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" });
    return true;
  }

  let m = /^\/t\/o\/([0-9a-f]{24})\.gif$/.exec(p);
  if (m) {
    recordOpen(ctx, m[1]!, now, req);
    send(res, 200, GIF, { "Content-Type": "image/gif", "Cache-Control": "no-store, max-age=0" });
    return true;
  }

  m = /^\/t\/c\/([0-9a-f]{24})$/.exec(p);
  if (m) {
    const id = m[1]!;
    const target = url.searchParams.get("u") ?? "";
    if (!/^https?:\/\//i.test(target) || !ctx.secrets.verify(url.searchParams.get("s") ?? "", "c", id, target)) {
      page(res, 400, "This link doesn't work", "It may have been cut short when it was copied.");
      return true;
    }
    const r = ctx.db.prepare("UPDATE messages SET clicks = clicks + 1, clicked_at = coalesce(clicked_at, ?), opened_at = coalesce(opened_at, ?) WHERE id = ? RETURNING clicks").get(now, now, id) as { clicks: number } | undefined;
    if (r && r.clicks <= MAX_EVENTS) ctx.mailer.event(id, "click", target, now);
    if (r) enrich(ctx, id, "click", req, now);
    send(res, 302, "", { Location: target, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    return true;
  }

  m = /^\/u\/([0-9a-f]{24})\.([\w-]{22})$/.exec(p);
  if (m) {
    const [, id, sig] = m as unknown as [string, string, string];
    const msg = ctx.secrets.verify(sig, "u", id) ? (ctx.db.prepare("SELECT m.brand_id, m.to_email, m.unsubscribed_at, b.name brand FROM messages m JOIN brands b ON b.id = m.brand_id WHERE m.id = ?").get(id) as { brand_id: number; to_email: string; unsubscribed_at: number | null; brand: string } | undefined) : undefined;
    if (!msg) {
      page(res, 404, "This link doesn't work", "It may be from an email that's been deleted.");
      return true;
    }
    if (req.method === "POST") {
      // RFC 8058's one-click (List-Unsubscribe=One-Click) or the page's button: either way, done.
      await readBody(req, 8192).catch(() => Buffer.alloc(0));
      ctx.contacts.unsubscribe(msg.brand_id, msg.to_email, now);
      if (!msg.unsubscribed_at) {
        ctx.db.prepare("UPDATE messages SET unsubscribed_at = ? WHERE id = ?").run(now, id);
        ctx.mailer.event(id, "unsubscribe", undefined, now);
      }
      page(res, 200, "You're unsubscribed", `${escapeHtml(msg.to_email)} won't get emails like this from ${escapeHtml(msg.brand)} again.`);
      return true;
    }
    page(res, 200, `Unsubscribe from ${msg.brand}?`, `${escapeHtml(msg.to_email)} won't get emails like this from ${escapeHtml(msg.brand)} again.`, { label: "Unsubscribe", action: p });
    return true;
  }

  m = /^\/subscribe\/([\w-]{12})$/.exec(p);
  if (m) {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    if (req.method === "OPTIONS") {
      send(res, 204, "", cors);
      return true;
    }
    const wantsJson = String(req.headers.accept ?? "").includes("application/json") || String(req.headers["content-type"] ?? "").includes("application/json");
    const answer = (status: number, title: string, line: string, redirect?: string) => {
      if (wantsJson) {
        for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
        return json(res, status, status < 300 ? { ok: true, status: title } : { ok: false, error: line });
      }
      if (redirect && status < 300) return send(res, 303, "", { Location: redirect });
      return page(res, status, title, escapeHtml(line));
    };
    if (req.method !== "POST") {
      answer(405, "Not here", "Signup forms post here.");
      return true;
    }
    const list = ctx.contacts.listByKey(m[1]!);
    if (!list) {
      answer(404, "No such list", "This signup form points at a list that's been deleted.");
      return true;
    }
    if (ctx.limits.signups.hit(`${limitKey(clientIp(req))}|${list.brandId}`)) {
      answer(429, "Too many tries", "Wait a minute, then try again.");
      return true;
    }
    const body = await form(req);
    const brand = ctx.brands.must(list.brandId);
    const redirect = redirectTo(body.redirect, req, brand);
    const ip = clientIp(req);
    const ua = req.headers["user-agent"];
    let contact;
    try {
      const email = checkEmail(body.email);
      const was = ctx.contacts.byEmail(list.brandId, email);
      // Shield, for a new address: a refused sign-up is told all went well, so a bot learns nothing.
      let flags: string[] | null = null;
      if (!was) {
        const elapsed = Number(body._el);
        const d = decide(
          await ctx.shield.checkSignup(list.brandId, { email, ip, userAgent: ua, honeypot: Boolean(body._hp), webdriver: body._wd === "true" || body._wd === true, elapsedMs: body._el !== undefined && Number.isFinite(elapsed) ? elapsed : undefined }),
          ctx.shield.settings(list.brandId),
        );
        ctx.shield.log(list.brandId, d.outcome, d.verdicts.map((v) => v.check), "form", ctx.country(ip));
        if (d.outcome === "refuse") {
          answer(200, list.doubleOptIn ? "confirm" : "subscribed", list.doubleOptIn ? "Check your inbox: we sent a link to confirm." : "You're subscribed. Thanks!", redirect);
          return true;
        }
        if (d.outcome === "flag") flags = d.verdicts.map((v) => v.check);
      } else if (body._hp) {
        // A filled-in honeypot on a known address: still a bot, still told all went well.
        answer(200, "subscribed", "Thanks!", redirect);
        return true;
      }
      if (was) {
        // Someone already here only joins the list. A form anyone can send never
        // changes their name, fields or status: an unsubscribe stands, and a
        // confirmation still has to come from their inbox.
        ctx.contacts.addToList(list.brandId, was.id, list.id);
        contact = ctx.contacts.get(list.brandId, was.id);
      } else {
        const fields = Object.fromEntries(Object.entries(body).filter(([k, v]) => /^[a-z][a-z0-9_]{0,39}$/.test(k) && !["email", "name", "redirect"].includes(k) && typeof v === "string"));
        // What the sign-up says about them (PLAN-EMAIL-2.md): the country of the IP, never the IP.
        const agent = readAgent(ua);
        const timezone = typeof body._tz === "string" && validTimeZone(body._tz) ? body._tz : null;
        contact = ctx.contacts.upsert(
          list.brandId,
          { email, name: body.name, fields, lists: [list.id], status: list.doubleOptIn ? "unconfirmed" : "subscribed" },
          { source: "form", flags, profile: { country: ctx.country(ip), timezone, device: agent.bot ? null : agent.device, client: agent.bot ? null : `${agent.browser} on ${agent.os}` } },
        ).contact;
      }
    } catch (err) {
      if (err instanceof InputError) {
        answer(422, "Check your email address", err.message);
        return true;
      }
      throw err;
    }
    // A link by email when there's something to confirm: a new address on a list
    // with double opt-in, one that was never confirmed, or one that unsubscribed
    // and asks to come back (only the link brings them back).
    const rejoin = contact.status === "unsubscribed";
    // A flagged address gets nothing from us, a confirmation included, until it's approved.
    if ((contact.status === "unconfirmed" || rejoin) && !contact.flags) {
      const parts = rejoin ? [String(list.brandId), String(contact.id), String(now)] : [String(list.brandId), String(contact.id)];
      const link = `${ctx.publicUrl()}/confirm/${parts.join(".")}.${ctx.secrets.sign(rejoin ? "rejoin" : "confirm", ...parts)}`;
      // Nothing goes to a suppressed address, or twice a day to one, but the form says the same either way.
      if (brand.fromEmail && ctx.domains.verifiedFor(brand.id, brand.fromEmail) && !ctx.contacts.isSuppressed(brand.id, contact.email) && !ctx.limits.confirmations.hit(`${brand.id}|${contact.email}`)) {
        ctx.mailer.queue({
          brandId: brand.id,
          kind: "confirm",
          contactId: contact.id,
          payload: {
            from: brand.fromName ? `${brand.fromName} <${brand.fromEmail}>` : brand.fromEmail,
            to: [contact.email],
            subject: rejoin ? `Confirm you'd like emails from ${brand.name} again` : `Confirm your subscription to ${brand.name}`,
            html: `<div style="font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px"><p>Please confirm you'd like emails from ${escapeHtml(brand.name)}${list.name ? ` (${escapeHtml(list.name)})` : ""}${rejoin ? " again" : ""}.</p><p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#171717;color:#fff;text-decoration:none">Confirm</a></p><p style="color:#737373;font-size:13px">If you didn't sign up, ignore this email: you won't hear from us.</p></div>`,
            text: `Please confirm you'd like emails from ${brand.name}${rejoin ? " again" : ""}: ${link}\n\nIf you didn't sign up, ignore this email.`,
          },
        });
      }
      answer(200, "confirm", "Check your inbox: we sent a link to confirm.", redirect);
      return true;
    }
    answer(200, "subscribed", contact.status === "subscribed" ? "You're subscribed. Thanks!" : "Thanks!", redirect);
    return true;
  }

  // The link's token: brand.contact.sig, or brand.contact.asked.sig for coming back after unsubscribing.
  m = /^\/confirm\/(\d+)\.(\d+)\.(?:(\d{13})\.)?([\w-]{22})$/.exec(p);
  if (m) {
    const [, brandId, contactId, asked, sig] = m as unknown as [string, string, string, string | undefined, string];
    const valid = asked ? ctx.secrets.verify(sig, "rejoin", brandId, contactId, asked) && now - Number(asked) <= REJOIN_MS : ctx.secrets.verify(sig, "confirm", brandId, contactId);
    if (!valid) {
      page(res, 400, "This link doesn't work", asked ? "It's over a week old, or was cut short when it was copied: sign up again for a new one." : "It may have been cut short when it was copied.");
      return true;
    }
    try {
      const brand = ctx.brands.must(Number(brandId));
      // Mail scanners open every link in an email: only the button confirms.
      if (req.method !== "POST") {
        const c = ctx.contacts.get(Number(brandId), Number(contactId));
        if (c.status === "subscribed") page(res, 200, "You're subscribed", `${escapeHtml(c.email)} gets emails from ${escapeHtml(brand.name)}.`);
        else page(res, 200, `Emails from ${brand.name}?`, `Confirm that ${escapeHtml(c.email)} would like emails from ${escapeHtml(brand.name)}.`, { label: "Confirm", action: p });
        return true;
      }
      await readBody(req, 8192).catch(() => Buffer.alloc(0));
      const c = asked ? ctx.contacts.rejoin(Number(brandId), Number(contactId), Number(asked)) : ctx.contacts.confirm(Number(brandId), Number(contactId));
      page(res, 200, "You're subscribed", c.status === "subscribed" ? `Thanks for confirming: ${escapeHtml(c.email)} will get emails from ${escapeHtml(brand.name)}.` : "This address can't be subscribed again from here.");
    } catch {
      page(res, 404, "This link doesn't work", "The subscription it confirms was deleted.");
    }
    return true;
  }

  if (p === "/webhooks/ses" && req.method === "POST") {
    let msg: SnsMessage;
    try {
      msg = JSON.parse((await readBody(req, 256 * 1024)).toString("utf8")) as SnsMessage;
    } catch {
      json(res, 400, { error: "not an SNS message" });
      return true;
    }
    const brandId = ctx.brands.sesTopics().get(msg.TopicArn);
    if (brandId === undefined || !(await verifySns(msg, { fetch: ctx.fetch, certificate: ctx.snsCertificate }))) {
      json(res, 403, { error: "not from this install's SNS topic" });
      return true;
    }
    if (msg.Type === "SubscriptionConfirmation" && msg.SubscribeURL) {
      const u = new URL(msg.SubscribeURL);
      if (u.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(u.hostname)) await (ctx.fetch ?? fetch)(msg.SubscribeURL, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
    } else if (msg.Type === "Notification") {
      sesEvent(ctx, brandId, JSON.parse(msg.Message) as SesEvent, now);
    }
    json(res, 200, { ok: true });
    return true;
  }
  return false;
}

interface SesEvent {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string };
  bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress: string; diagnosticCode?: string }[] };
  complaint?: { complainedRecipients?: { emailAddress: string }[] };
  reject?: { reason?: string };
}

/** What SES reported about a message it sent for this brand. */
export function sesEvent(ctx: PublicContext, brandId: number, e: SesEvent, now = Date.now()): void {
  const type = e.eventType ?? e.notificationType;
  const msg = e.mail?.messageId ? (ctx.db.prepare("SELECT id FROM messages WHERE provider_id = ? AND brand_id = ?").get(e.mail.messageId, brandId) as { id: string } | undefined) : undefined;
  if (type === "Delivery") {
    if (msg) {
      ctx.db.prepare("UPDATE messages SET status = 'delivered' WHERE id = ? AND status = 'sent'").run(msg.id);
      ctx.mailer.event(msg.id, "delivered", undefined, now);
    }
  } else if (type === "Bounce") {
    const permanent = e.bounce?.bounceType === "Permanent";
    for (const r of e.bounce?.bouncedRecipients ?? []) {
      if (permanent) ctx.contacts.suppress(brandId, r.emailAddress, "bounce", r.diagnosticCode ?? "");
      if (msg) ctx.mailer.event(msg.id, permanent ? "bounce" : "deferred", `${r.emailAddress}: ${r.diagnosticCode ?? e.bounce?.bounceType ?? ""}`, now);
    }
    if (msg && permanent) ctx.db.prepare("UPDATE messages SET status = 'bounced' WHERE id = ?").run(msg.id);
  } else if (type === "Complaint") {
    for (const r of e.complaint?.complainedRecipients ?? []) ctx.contacts.suppress(brandId, r.emailAddress, "complaint", "marked as spam");
    if (msg) {
      ctx.db.prepare("UPDATE messages SET status = 'complained' WHERE id = ?").run(msg.id);
      ctx.mailer.event(msg.id, "complaint", undefined, now);
    }
  } else if (type === "Reject" && msg) {
    ctx.db.prepare("UPDATE messages SET status = 'failed', error = ? WHERE id = ?").run(`SES rejected it: ${e.reject?.reason ?? ""}`, msg.id);
    ctx.mailer.event(msg.id, "failed", e.reject?.reason, now);
  }
}

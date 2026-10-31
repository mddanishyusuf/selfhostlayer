// The API apps call with a brand's key (Authorization: Bearer em_…), on the
// install's public address. Sending is Resend-compatible, so Resend's SDKs
// work with this address as their base URL:
//   POST /emails          { from, to, subject, html, text, cc, bcc, reply_to,
//                          headers, attachments, tags, scheduled_at,
//                          template: { id, variables } }  →  { id }
//   POST /emails/batch    up to 100 of them                →  { data: [{ id }] }
//   GET  /emails/:id      its status (last_event) and content
// and also (each under /v1/ too):
//   POST /contacts        add or update { email, name, fields, lists, unsubscribed }
//   GET|DELETE /contacts/:email
//   POST /events          { email, name, data }: starts automations listening for it
// Errors are Resend's shape: { statusCode, name, message }. Keys are kept as
// sha256 hashes, each at most 20 requests a second.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { bearer, InputError, json, readJson } from "../../lib/http.ts";
import type { Automations } from "./automations.ts";
import { text, type Brands } from "./brands.ts";
import type { Contacts } from "./contacts.ts";
import type { Domains } from "./domains.ts";
import type { Mailer, Payload } from "./mailer.ts";
import { checkHeaders, domainOf, formatAddress, parseAddress, parseAddresses } from "./mime.ts";
import type { Templates } from "./templates.ts";

export interface KeyInfo {
  id: number;
  brandId: number;
  name: string;
  /** The start of the key (em_ab12cd), to tell keys apart. */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

export class ApiKeys {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  create(brandId: number, nameValue: unknown): { key: string; info: KeyInfo } {
    const name = text(nameValue, "name", 60, { required: true });
    if ((this.#db.prepare("SELECT count(*) n FROM api_keys WHERE brand_id = ?").get(brandId) as { n: number }).n >= 50) throw new InputError("name", "at most 50 keys: revoke one first", 409);
    const key = `em_${randomBytes(24).toString("base64url")}`;
    const now = Date.now();
    const id = Number(this.#db.prepare("INSERT INTO api_keys (brand_id, name, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)").run(brandId, name, hash(key), key.slice(0, 9), now).lastInsertRowid);
    return { key, info: { id, brandId, name, prefix: key.slice(0, 9), createdAt: now, lastUsedAt: null } };
  }

  list(brandId: number): KeyInfo[] {
    return this.#db.prepare("SELECT id, brand_id brandId, name, prefix, created_at createdAt, last_used_at lastUsedAt FROM api_keys WHERE brand_id = ? ORDER BY id").all(brandId) as unknown as KeyInfo[];
  }

  revoke(brandId: number, id: number): void {
    if (!Number(this.#db.prepare("DELETE FROM api_keys WHERE id = ? AND brand_id = ?").run(id, brandId).changes)) throw new InputError("key", "no such key", 404);
  }

  /** The key's record, its last use noted (at most once a minute). */
  use(key: string, now = Date.now()): KeyInfo | null {
    const r = this.#db.prepare("SELECT id, brand_id brandId, name, prefix, created_at createdAt, last_used_at lastUsedAt FROM api_keys WHERE key_hash = ?").get(hash(key)) as KeyInfo | undefined;
    if (!r) return null;
    if (!r.lastUsedAt || now - r.lastUsedAt > 60_000) this.#db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, r.id);
    return r;
  }
}

export interface ApiContext {
  db: DatabaseSync;
  brands: Brands;
  domains: Domains;
  contacts: Contacts;
  templates: Templates;
  automations: Automations;
  mailer: Mailer;
  keys: ApiKeys;
}

/** Resend's error names, by status. */
const NAMES: Record<number, string> = { 400: "validation_error", 401: "missing_api_key", 403: "invalid_api_key", 404: "not_found", 409: "validation_error", 413: "validation_error", 422: "validation_error", 429: "rate_limit_exceeded" };

export function apiFail(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return void res.destroy();
  if (err instanceof InputError) {
    const status = err.status === 400 ? 422 : err.status;
    // Validation errors name the field; the others say it all.
    const named = status === 422 && err.field && !err.message.startsWith(err.field);
    return json(res, status, { statusCode: status, name: NAMES[status] ?? "application_error", message: named ? `${err.field}: ${err.message}` : err.message });
  }
  console.error(err);
  json(res, 500, { statusCode: 500, name: "application_error", message: "something went wrong on the server" });
}

const MAX_ATTACHMENTS = 10 * 1024 * 1024;
const TYPES: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", txt: "text/plain", csv: "text/csv", html: "text/html", ics: "text/calendar", json: "application/json", zip: "application/zip" };

/** One email of the API's input, checked, as the queue stores it; and when it goes. */
export function toPayload(ctx: ApiContext, brandId: number, input: Record<string, unknown>, field = ""): { payload: Payload; sendAt: number | null; tags: unknown } {
  const f = (name: string) => (field ? `${field}.${name}` : name);
  const from = parseAddress(input.from, f("from"));
  if (!ctx.domains.verifiedFor(brandId, from.email)) throw new InputError(f("from"), `The ${domainOf(from.email)} domain is not verified. Add and verify it on the brand's Domains page.`, 403);
  const to = parseAddresses(input.to, f("to"));
  if (!to.length) throw new InputError(f("to"), "is required");
  const cc = parseAddresses(input.cc, f("cc"));
  const bcc = parseAddresses(input.bcc, f("bcc"));
  if (to.length + cc.length + bcc.length > 50) throw new InputError(f("to"), "at most 50 recipients in all");
  const replyTo = parseAddresses(input.reply_to ?? input.replyTo, f("reply_to"));
  let subject = typeof input.subject === "string" ? input.subject : "";
  let html = typeof input.html === "string" ? input.html : undefined;
  let textBody = typeof input.text === "string" ? input.text : undefined;
  const template = (input.template ?? (input.template_id !== undefined ? { id: input.template_id, variables: input.variables } : undefined)) as { id?: unknown; variables?: unknown } | undefined;
  if (template !== undefined) {
    if (typeof template !== "object" || template === null) throw new InputError(f("template"), "must be { id, variables }");
    const t = ctx.templates.get(brandId, Number(template.id));
    const vars = template.variables === undefined ? {} : template.variables;
    if (typeof vars !== "object" || vars === null || Array.isArray(vars)) throw new InputError(f("template.variables"), "must be an object");
    const r = ctx.templates.render(t, vars as Record<string, unknown>);
    subject ||= r.subject;
    html ??= r.html;
    textBody ??= r.text;
  }
  subject = subject.replace(/[\r\n]+/g, " ").trim();
  if (!subject) throw new InputError(f("subject"), "is required");
  if (subject.length > 998) throw new InputError(f("subject"), "is too long");
  if (!html && !textBody) throw new InputError(f("html"), "html, text or a template is required");
  if ((html?.length ?? 0) + (textBody?.length ?? 0) > 5_000_000) throw new InputError(f("html"), "is over 5 MB");
  let bytes = 0;
  const attachments = (Array.isArray(input.attachments) ? input.attachments : input.attachments === undefined ? [] : null)?.map((a: Record<string, unknown>, i: number) => {
    const af = f(`attachments[${i}]`);
    if (typeof a !== "object" || a === null) throw new InputError(af, "must be { filename, content }");
    if (a.path !== undefined) throw new InputError(`${af}.path`, "isn't supported here: send the file's content in base64");
    const filename = text(a.filename, `${af}.filename`, 200, { required: true }).replace(/[\r\n"\\/]/g, "_");
    if (typeof a.content !== "string" || !/^[A-Za-z0-9+/=\s]*$/.test(a.content)) throw new InputError(`${af}.content`, "must be the file in base64");
    const content = Buffer.from(a.content, "base64");
    bytes += content.length;
    const contentType = typeof a.content_type === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(a.content_type) ? a.content_type : (TYPES[filename.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream");
    return { filename, content: content.toString("base64"), contentType };
  });
  if (attachments === null || attachments === undefined) throw new InputError(f("attachments"), "must be a list");
  if (bytes > MAX_ATTACHMENTS) throw new InputError(f("attachments"), "are over 10 MB in all");
  if (attachments.length > 20) throw new InputError(f("attachments"), "at most 20");
  const tags = input.tags;
  if (tags !== undefined && (!Array.isArray(tags) || tags.length > 10 || tags.some((t: Record<string, unknown>) => typeof t?.name !== "string" || typeof (t.value ?? "") !== "string"))) throw new InputError(f("tags"), "must be up to 10 { name, value }");
  let sendAt: number | null = null;
  const scheduled = input.scheduled_at ?? input.scheduledAt;
  if (scheduled !== undefined && scheduled !== null) {
    sendAt = Date.parse(String(scheduled));
    if (!Number.isFinite(sendAt)) throw new InputError(f("scheduled_at"), "must be a date and time (ISO 8601)");
    if (sendAt > Date.now() + 30 * 86_400_000) throw new InputError(f("scheduled_at"), "must be within 30 days");
  }
  // Suppressed addresses are left out; when nobody's left, nothing is sent.
  const keep = (list: typeof to) => list.filter((a) => !ctx.contacts.isSuppressed(brandId, a.email));
  const [okTo, okCc, okBcc] = [keep(to), keep(cc), keep(bcc)];
  if (!okTo.length && !okCc.length && !okBcc.length) throw new InputError(f("to"), "every recipient is on the suppression list (they bounced, complained or unsubscribed)", 422);
  return {
    payload: {
      from: formatAddress(from),
      to: okTo.map(formatAddress),
      cc: okCc.map(formatAddress),
      bcc: okBcc.map(formatAddress),
      replyTo: replyTo.map(formatAddress),
      subject,
      html,
      text: textBody,
      headers: checkHeaders(input.headers, f("headers")),
      attachments,
    },
    sendAt,
    tags,
  };
}

/** What Resend calls the last event, from a message's status and tracking. */
function lastEvent(m: { status: string; opened_at: number | null; clicked_at: number | null }): string {
  if (m.status === "sent" || m.status === "delivered") return m.clicked_at ? "clicked" : m.opened_at ? "opened" : m.status;
  return m.status;
}

const limits = new Map<number, { n: number; reset: number }>();
function limited(keyId: number, now: number): boolean {
  const w = limits.get(keyId);
  if (!w || w.reset <= now) {
    limits.set(keyId, { n: 1, reset: now + 1000 });
    return false;
  }
  return ++w.n > 20;
}

function idempotent(ctx: ApiContext, keyId: number, key: string | undefined, run: () => unknown): unknown {
  if (!key) return run();
  if (key.length > 256) throw new InputError("Idempotency-Key", "must be at most 256 characters");
  const seen = ctx.db.prepare("SELECT response FROM idempotency WHERE key_id = ? AND key = ? AND created_at > ?").get(keyId, key, Date.now() - 86_400_000) as { response: string } | undefined;
  if (seen) return JSON.parse(seen.response);
  const out = run();
  ctx.db.prepare("INSERT OR REPLACE INTO idempotency (key_id, key, response, created_at) VALUES (?, ?, ?, ?)").run(keyId, key, JSON.stringify(out), Date.now());
  return out;
}

/** Handles /emails, /contacts, /events (and /v1/…); false when the path isn't the API's. */
export async function handleApi(req: IncomingMessage, res: ServerResponse, ctx: ApiContext, url: URL): Promise<boolean> {
  const path = url.pathname.replace(/^\/v1(?=\/)/, "").replace(/\/+$/, "");
  const [, resource, rest] = path.split("/");
  if (resource !== "emails" && resource !== "contacts" && resource !== "events") return false;
  try {
    const key = bearer(req);
    if (!key) throw new InputError("Authorization", "Missing API key in the authorization header", 401);
    const info = ctx.keys.use(key);
    if (!info) throw new InputError("Authorization", "API key is invalid", 403);
    if (limited(info.id, Date.now())) throw new InputError("rate", "Too many requests: at most 20 a second for each key", 429);
    const brandId = info.brandId;
    const method = req.method ?? "GET";
    const idemKey = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : undefined;

    if (resource === "emails" && method === "POST" && !rest) {
      const body = await readJson(req, 16 * 1024 * 1024);
      const out = idempotent(ctx, info.id, idemKey, () => {
        const p = toPayload(ctx, brandId, body);
        return { id: ctx.mailer.queue({ brandId, kind: "transactional", payload: p.payload, sendAt: p.sendAt ?? undefined, tags: p.tags }) };
      });
      json(res, 200, out);
      return true;
    }
    if (resource === "emails" && method === "POST" && rest === "batch") {
      const raw = await readBatch(req);
      if (raw.length > 100) throw new InputError("emails", "at most 100 in a batch");
      const out = idempotent(ctx, info.id, idemKey, () => {
        // Every email is checked before any is queued: all or nothing.
        const payloads = raw.map((e, i) => toPayload(ctx, brandId, e, `[${i}]`));
        return { data: payloads.map((p) => ({ id: ctx.mailer.queue({ brandId, kind: "transactional", payload: p.payload, sendAt: p.sendAt ?? undefined, tags: p.tags }) })) };
      });
      json(res, 200, out);
      return true;
    }
    if (resource === "emails" && method === "GET" && rest) {
      const m = ctx.db.prepare("SELECT * FROM messages WHERE id = ? AND brand_id = ?").get(rest, brandId) as Record<string, any> | undefined;
      if (!m) throw new InputError("id", "Email not found", 404);
      const body = ctx.db.prepare("SELECT payload FROM message_bodies WHERE message_id = ?").get(rest) as { payload: string } | undefined;
      const p = body ? (JSON.parse(body.payload) as Payload) : null;
      json(res, 200, {
        object: "email",
        id: m.id,
        to: p?.to ?? [m.to_email],
        from: p?.from ?? m.from_email,
        created_at: new Date(m.created_at).toISOString(),
        subject: m.subject,
        html: p?.html ?? null,
        text: p?.text ?? null,
        cc: p?.cc ?? [],
        bcc: p?.bcc ?? [],
        reply_to: p?.replyTo ?? [],
        last_event: lastEvent(m as never),
        scheduled_at: m.send_at > m.created_at + 1000 ? new Date(m.send_at).toISOString() : null,
      });
      return true;
    }
    if (resource === "contacts" && method === "POST" && !rest) {
      const body = await readJson(req);
      const status = body.unsubscribed === true ? "unsubscribed" : body.unsubscribed === false ? "subscribed" : undefined;
      const r = ctx.contacts.upsert(brandId, { email: body.email, name: body.name, fields: body.fields, lists: body.lists, status }, { resubscribe: body.unsubscribed === false, source: "api" });
      json(res, r.created ? 201 : 200, { object: "contact", id: r.contact.id, email: r.contact.email, status: r.contact.status, created: r.created });
      return true;
    }
    if (resource === "contacts" && rest) {
      const email = decodeURIComponent(rest).toLowerCase();
      const c = ctx.contacts.byEmail(brandId, email);
      if (!c) throw new InputError("email", "Contact not found", 404);
      if (method === "GET") {
        json(res, 200, { object: "contact", id: c.id, email: c.email, name: c.name, fields: c.fields, status: c.status, lists: c.lists, created_at: new Date(c.createdAt).toISOString() });
        return true;
      }
      if (method === "DELETE") {
        ctx.contacts.remove(brandId, c.id);
        json(res, 200, { object: "contact", id: c.id, deleted: true });
        return true;
      }
    }
    if (resource === "events" && method === "POST" && !rest) {
      const r = ctx.automations.onEvent(brandId, await readJson(req));
      json(res, 200, { object: "event", started: r.started });
      return true;
    }
    throw new InputError("path", "Not found", 404);
  } catch (err) {
    apiFail(res, err);
    return true;
  }
}

/** A batch is a JSON array (Resend's shape), or { emails: [...] }. */
async function readBatch(req: IncomingMessage): Promise<Record<string, unknown>[]> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 32 * 1024 * 1024) throw new InputError("body", "the request is over 32 MB", 413);
    chunks.push(c as Buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InputError("body", "must be a JSON array of emails");
  }
  const list = Array.isArray(value) ? value : (value as { emails?: unknown })?.emails;
  if (!Array.isArray(list) || list.some((e) => typeof e !== "object" || e === null)) throw new InputError("body", "must be a JSON array of emails");
  return list as Record<string, unknown>[];
}

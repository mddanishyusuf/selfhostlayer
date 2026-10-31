// The queue and its worker. Every email is a row in messages: queued, then
// claimed by a worker (UPDATE … RETURNING, so the two colors of a deploy never
// take the same row), sent through its brand's provider, and marked sent,
// bounced or failed. Each brand sends at its own rate (a token bucket); a
// transient failure is tried again after 1, 5 and 30 minutes. A claim older
// than 10 minutes (a crash mid-send) goes back to the queue.
//
// Campaign emails are rendered when they're sent, from the campaign and the
// contact; every other kind is stored rendered (message_bodies), its body kept
// for the logs until the daily prune.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Brands } from "./brands.ts";
import type { Contacts } from "./contacts.ts";
import type { Domains } from "./domains.ts";
import { buildMessage, domainOf, parseAddress, parseAddresses, type Address, type Attachment } from "./mime.ts";
import { SendError } from "./providers.ts";
import { contactVars, renderMarketing, type Vars } from "./render.ts";
import type { Secrets } from "../../lib/secrets.ts";

export type Kind = "campaign" | "transactional" | "automation" | "test" | "confirm";

/** A message as stored for sending: addresses as text ("Name <email>"), attachments in base64. */
export interface Payload {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; content: string; contentType: string }[];
  /** Marketing email: List-Unsubscribe and the one-click header. */
  unsubscribe?: boolean;
}

export interface MessageRow {
  id: string;
  brand_id: number;
  kind: Kind;
  campaign_id: number | null;
  automation_id: number | null;
  contact_id: number | null;
  to_email: string;
  from_email: string;
  subject: string;
  status: string;
  attempts: number;
  send_at: number;
}

export const newMessageId = () => randomBytes(12).toString("hex");
export const CLAIM = 10 * 60_000;
const RETRY = [60_000, 5 * 60_000, 30 * 60_000];
export const MAX_ATTEMPTS = 3;

interface CampaignForSend {
  subject: string;
  preheader: string;
  html: string;
  text: string;
  from: string;
  replyTo: string;
  at: number;
}

export interface MailerOptions {
  db: DatabaseSync;
  brands: Brands;
  domains: Domains;
  contacts: Contacts;
  secrets: Secrets;
  /** This install's public address, like https://email.example.com. */
  publicUrl: () => string;
}

export class Mailer {
  readonly #o: MailerOptions;
  readonly #buckets = new Map<number, { tokens: number; at: number }>();
  readonly #campaigns = new Map<number, CampaignForSend>();
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<number> | null = null;

  constructor(o: MailerOptions) {
    this.#o = o;
  }

  // The links an email carries.
  unsubscribeUrl = (id: string) => `${this.#o.publicUrl()}/u/${id}.${this.#o.secrets.sign("u", id)}`;
  openUrl = (id: string) => `${this.#o.publicUrl()}/t/o/${id}.gif`;
  clickUrl = (id: string, url: string) => `${this.#o.publicUrl()}/t/c/${id}?u=${encodeURIComponent(url)}&s=${this.#o.secrets.sign("c", id, url)}`;

  /** Queues a message ready to send; returns its id. */
  queue(o: { brandId: number; kind: Kind; payload: Payload; id?: string; contactId?: number | null; campaignId?: number | null; automationId?: number | null; sendAt?: number; priority?: number; tags?: unknown }): string {
    const id = o.id ?? newMessageId();
    const now = Date.now();
    const from = parseAddress(o.payload.from, "from");
    this.#o.db
      .prepare("INSERT INTO messages (id, brand_id, kind, campaign_id, automation_id, contact_id, to_email, from_email, subject, priority, send_at, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        id,
        o.brandId,
        o.kind,
        o.campaignId ?? null,
        o.automationId ?? null,
        o.contactId ?? null,
        [...parseAddresses(o.payload.to, "to"), ...parseAddresses(o.payload.cc ?? [], "cc"), ...parseAddresses(o.payload.bcc ?? [], "bcc")][0]?.email ?? "",
        from.email,
        o.payload.subject.slice(0, 500),
        o.priority ?? (o.kind === "transactional" || o.kind === "confirm" || o.kind === "test" ? 10 : 0),
        o.sendAt ?? now,
        o.tags === undefined ? null : JSON.stringify(o.tags),
        now,
      );
    this.#o.db.prepare("INSERT INTO message_bodies (message_id, payload) VALUES (?, ?)").run(id, JSON.stringify(o.payload));
    this.event(id, "queued");
    return id;
  }

  /** A marketing email (an automation's step) for one contact, rendered and tracked now, queued. */
  queueMarketing(o: { brandId: number; kind: Kind; contact: { id: number; email: string; name: string; fields: Record<string, string> }; from: string; replyTo?: string; subject: string; preheader?: string; html: string; text?: string; vars?: Vars; automationId?: number }): string {
    const brand = this.#o.brands.must(o.brandId);
    const id = newMessageId();
    const r = renderMarketing({
      subject: o.subject,
      html: o.html,
      text: o.text ?? "",
      preheader: o.preheader ?? "",
      vars: { ...contactVars(o.contact), ...(o.vars ?? {}) },
      brand,
      unsubscribeUrl: this.unsubscribeUrl(id),
      openUrl: this.openUrl(id),
      clickUrl: (url) => this.clickUrl(id, url),
    });
    return this.queue({
      id,
      brandId: o.brandId,
      kind: o.kind,
      contactId: o.contact.id,
      automationId: o.automationId ?? null,
      payload: { from: o.from, to: [o.contact.email], replyTo: o.replyTo ? [o.replyTo] : [], subject: r.subject, html: r.html, text: r.text, unsubscribe: true },
    });
  }

  event(messageId: string, kind: string, detail?: string, at = Date.now()): void {
    this.#o.db.prepare("INSERT INTO events (message_id, at, kind, detail) VALUES (?, ?, ?, ?)").run(messageId, at, kind, detail?.slice(0, 1000) ?? null);
  }

  start(everyMs = 250): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      if (!this.#running) this.#running = this.tick().finally(() => (this.#running = null));
    }, everyMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running?.catch(() => 0);
  }

  #allowance(brandId: number, rate: number, now: number): number {
    const cap = Math.max(1, rate);
    const b = this.#buckets.get(brandId) ?? { tokens: cap, at: now };
    b.tokens = Math.min(cap, b.tokens + ((now - b.at) / 1000) * rate);
    b.at = now;
    this.#buckets.set(brandId, b);
    return Math.floor(b.tokens);
  }

  /** Sends what's due, at each brand's rate; returns how many messages it handled. */
  async tick(now = Date.now()): Promise<number> {
    const db = this.#o.db;
    // Claims a crash left behind.
    db.prepare("UPDATE messages SET status = 'queued', claimed_until = NULL WHERE status = 'sending' AND claimed_until < ?").run(now);
    const due = db
      .prepare(
        `SELECT DISTINCT m.brand_id id, b.rate FROM messages m JOIN brands b ON b.id = m.brand_id WHERE m.status = 'queued' AND m.send_at <= ?
           AND NOT EXISTS (SELECT 1 FROM campaigns c WHERE c.id = m.campaign_id AND c.status IN ('paused', 'cancelled'))`,
      )
      .all(now) as { id: number; rate: number }[];
    let handled = 0;
    await Promise.all(
      due.map(async ({ id: brandId, rate }) => {
        const n = Math.min(this.#allowance(brandId, rate, now), 25);
        if (n < 1) return;
        const claimed = db
          .prepare(
            `UPDATE messages SET status = 'sending', claimed_until = ?, attempts = attempts + 1 WHERE id IN (
               SELECT m.id FROM messages m WHERE m.brand_id = ? AND m.status = 'queued' AND m.send_at <= ?
                 AND NOT EXISTS (SELECT 1 FROM campaigns c WHERE c.id = m.campaign_id AND c.status IN ('paused', 'cancelled'))
               ORDER BY m.priority DESC, m.send_at, m.rowid LIMIT ?) AND status = 'queued' RETURNING *`,
          )
          .all(now + CLAIM, brandId, now, n) as unknown as MessageRow[];
        this.#buckets.get(brandId)!.tokens -= claimed.length;
        handled += claimed.length;
        await Promise.all(claimed.map((m) => this.#deliver(m)));
      }),
    );
    return handled;
  }

  /** Sends one queued message now (a test from the panel), without trying again later, and says how it went. */
  async sendNow(id: string): Promise<{ id: string; status: string; error: string | null }> {
    const m = this.#o.db.prepare("UPDATE messages SET status = 'sending', claimed_until = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued' RETURNING *").get(Date.now() + CLAIM, id) as unknown as MessageRow | undefined;
    if (m) await this.#deliver({ ...m, attempts: MAX_ATTEMPTS });
    const r = this.#o.db.prepare("SELECT status, error FROM messages WHERE id = ?").get(id) as { status: string; error: string | null };
    return { id, status: r.status, error: r.error };
  }

  /** Sends whatever is due, again and again until the queue is empty, moving the clock a second each time (tests). */
  async drain(max = 1000): Promise<number> {
    let total = 0;
    for (let i = 0; i < max; i++) {
      const n = await this.tick(Date.now() + 1000 * i);
      total += n;
      if (!n && !(this.#o.db.prepare("SELECT 1 FROM messages WHERE status = 'queued' AND send_at <= ?").get(Date.now() + 1000 * i) as unknown)) break;
    }
    return total;
  }

  #campaign(id: number, now: number): CampaignForSend | null {
    const c = this.#campaigns.get(id);
    if (c && now - c.at < 10_000) return c;
    const r = this.#o.db.prepare("SELECT c.subject, c.preheader, c.html, c.text, c.from_name, c.from_email, c.reply_to FROM campaigns c WHERE c.id = ?").get(id) as
      | { subject: string; preheader: string; html: string; text: string; from_name: string; from_email: string; reply_to: string }
      | undefined;
    if (!r) return null;
    const out = { subject: r.subject, preheader: r.preheader, html: r.html, text: r.text, from: r.from_name ? `${r.from_name} <${r.from_email}>` : r.from_email, replyTo: r.reply_to, at: now };
    this.#campaigns.set(id, out);
    return out;
  }

  /** The message as sent: its MIME, who gets it, and the domain it's from. */
  #compose(m: MessageRow): { raw: Buffer; from: Address; to: string[] } {
    let p: Payload;
    if (m.kind === "campaign") {
      const c = this.#campaign(m.campaign_id!, Date.now());
      if (!c) throw new SendError("the campaign was deleted", true);
      const contact = m.contact_id ? (this.#o.db.prepare("SELECT email, name, fields FROM contacts WHERE id = ?").get(m.contact_id) as { email: string; name: string; fields: string } | undefined) : undefined;
      if (!contact) throw new SendError("the contact was deleted", true);
      const brand = this.#o.brands.must(m.brand_id);
      const r = renderMarketing({
        ...c,
        vars: contactVars({ ...contact, fields: JSON.parse(contact.fields) }),
        brand,
        unsubscribeUrl: this.unsubscribeUrl(m.id),
        openUrl: this.openUrl(m.id),
        clickUrl: (url) => this.clickUrl(m.id, url),
      });
      p = { from: c.from, to: [contact.email], replyTo: c.replyTo ? [c.replyTo] : [], subject: r.subject, html: r.html, text: r.text, unsubscribe: true, headers: { "Feedback-ID": `${m.campaign_id}:${m.brand_id}:shl` } };
    } else {
      const body = this.#o.db.prepare("SELECT payload FROM message_bodies WHERE message_id = ?").get(m.id) as { payload: string } | undefined;
      if (!body) throw new SendError("the message's body is gone", true);
      p = JSON.parse(body.payload) as Payload;
    }
    const from = parseAddress(p.from, "from");
    const to = parseAddresses(p.to, "to");
    const cc = parseAddresses(p.cc ?? [], "cc");
    const bcc = parseAddresses(p.bcc ?? [], "bcc");
    const attachments: Attachment[] = (p.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content, "base64") }));
    const raw = buildMessage({
      from,
      to,
      cc,
      replyTo: parseAddresses(p.replyTo ?? [], "replyTo"),
      subject: p.subject,
      html: p.html,
      text: p.text,
      headers: p.headers,
      attachments,
      id: m.id,
      unsubscribe: p.unsubscribe ? { url: this.unsubscribeUrl(m.id), oneClick: true } : undefined,
    });
    return { raw, from, to: [...to, ...cc, ...bcc].map((a) => a.email) };
  }

  async #deliver(m: MessageRow): Promise<void> {
    const db = this.#o.db;
    const now = () => Date.now();
    try {
      const { raw, from, to } = this.#compose(m);
      if (m.kind !== "test" && !this.#o.domains.verifiedFor(m.brand_id, from.email)) throw new SendError(`${domainOf(from.email)} isn't a verified domain of this brand`, true);
      const sent = await this.#o.brands.sender(m.brand_id).send({ from: from.email, fromDomain: domainOf(from.email), to, raw });
      db.prepare("UPDATE messages SET status = 'sent', sent_at = ?, provider_id = ?, error = NULL, claimed_until = NULL WHERE id = ?").run(now(), sent.providerId, m.id);
      this.event(m.id, "sent", sent.providerId ?? undefined);
      for (const r of sent.refused) {
        this.event(m.id, r.permanent ? "bounce" : "deferred", `${r.to}: ${r.reason}`);
        if (r.permanent) this.#o.contacts.suppress(m.brand_id, r.to, "bounce", r.reason);
      }
    } catch (err) {
      const e = err instanceof SendError ? err : new SendError((err as Error).message, false);
      if (e.bounce) {
        db.prepare("UPDATE messages SET status = 'bounced', error = ?, claimed_until = NULL WHERE id = ?").run(e.message.slice(0, 1000), m.id);
        this.event(m.id, "bounce", e.message);
        this.#o.contacts.suppress(m.brand_id, m.to_email, "bounce", e.message);
      } else if (!e.permanent && m.attempts < MAX_ATTEMPTS) {
        db.prepare("UPDATE messages SET status = 'queued', send_at = ?, error = ?, claimed_until = NULL WHERE id = ?").run(now() + RETRY[m.attempts - 1]!, e.message.slice(0, 1000), m.id);
        this.event(m.id, "deferred", e.message);
      } else {
        db.prepare("UPDATE messages SET status = 'failed', error = ?, claimed_until = NULL WHERE id = ?").run(e.message.slice(0, 1000), m.id);
        this.event(m.id, "failed", e.message);
      }
    }
  }
}

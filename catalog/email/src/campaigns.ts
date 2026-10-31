// Campaigns: one email to the subscribed contacts of some lists (minus other
// lists, minus the suppression list, each address once). A draft is
// scheduled (or sent now); when it's due, its audience becomes queued messages
// in one transaction, and the worker sends them at the brand's rate. It pauses
// by itself when hard bounces pass 5% or complaints 0.3% of what it sent
// (after 200 sends), as SES pauses accounts; it can be resumed or cancelled.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { InputError } from "../../lib/http.ts";
import { text, type Brands } from "./brands.ts";
import type { Contacts } from "./contacts.ts";
import { tx } from "./db.ts";
import type { Domains } from "./domains.ts";
import { isEmail } from "./mime.ts";

export type CampaignStatus = "draft" | "scheduled" | "sending" | "paused" | "sent" | "cancelled";

export interface CampaignStats {
  recipients: number;
  queued: number;
  sent: number;
  delivered: number;
  failed: number;
  bounced: number;
  complained: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
}

export interface Campaign {
  id: number;
  brandId: number;
  name: string;
  subject: string;
  preheader: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  html: string;
  text: string;
  /** What the panel's editor shows: the Markdown it was written in, or the HTML. */
  source: string;
  format: "markdown" | "html";
  lists: number[];
  excludeLists: number[];
  status: CampaignStatus;
  pausedReason: string | null;
  scheduledAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
  stats: CampaignStats;
}

interface Row {
  id: number;
  brand_id: number;
  name: string;
  subject: string;
  preheader: string;
  from_name: string;
  from_email: string;
  reply_to: string;
  html: string;
  text: string;
  source: string;
  format: "markdown" | "html";
  lists: string;
  exclude_lists: string;
  status: CampaignStatus;
  paused_reason: string | null;
  scheduled_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  recipients: number;
  created_at: number;
  updated_at: number;
}

const GUARD_AFTER = 200;
const MAX_BOUNCE = 0.05;
const MAX_COMPLAINT = 0.003;

export class Campaigns {
  readonly #db: DatabaseSync;
  readonly #brands: Brands;
  readonly #domains: Domains;
  readonly #contacts: Contacts;

  constructor(o: { db: DatabaseSync; brands: Brands; domains: Domains; contacts: Contacts }) {
    this.#db = o.db;
    this.#brands = o.brands;
    this.#domains = o.domains;
    this.#contacts = o.contacts;
  }

  stats(id: number, recipients: number): CampaignStats {
    const s = { recipients, queued: 0, sent: 0, delivered: 0, failed: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, unsubscribed: 0 };
    for (const r of this.#db.prepare("SELECT status, count(*) n, count(opened_at) o, count(clicked_at) c, count(unsubscribed_at) u FROM messages WHERE campaign_id = ? GROUP BY status").all(id) as { status: string; n: number; o: number; c: number; u: number }[]) {
      if (r.status === "queued" || r.status === "sending") s.queued += r.n;
      else if (r.status === "sent") s.sent += r.n;
      else if (r.status === "delivered") s.delivered += r.n;
      else if (r.status === "failed") s.failed += r.n;
      else if (r.status === "bounced") s.bounced += r.n;
      else if (r.status === "complained") s.complained += r.n;
      s.opened += r.o;
      s.clicked += r.c;
      s.unsubscribed += r.u;
    }
    // Delivered and complained messages were sent too.
    s.sent += s.delivered + s.complained;
    return s;
  }

  #from(r: Row): Campaign {
    return {
      id: r.id,
      brandId: r.brand_id,
      name: r.name,
      subject: r.subject,
      preheader: r.preheader,
      fromName: r.from_name,
      fromEmail: r.from_email,
      replyTo: r.reply_to,
      html: r.html,
      text: r.text,
      source: r.source,
      format: r.format,
      lists: JSON.parse(r.lists),
      excludeLists: JSON.parse(r.exclude_lists),
      status: r.status,
      pausedReason: r.paused_reason,
      scheduledAt: r.scheduled_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      stats: this.stats(r.id, r.recipients),
    };
  }

  list(brandId: number): Campaign[] {
    return (this.#db.prepare("SELECT * FROM campaigns WHERE brand_id = ? ORDER BY coalesce(started_at, scheduled_at, updated_at) DESC, id DESC").all(brandId) as unknown as Row[]).map((r) => this.#from(r));
  }

  get(brandId: number, id: number): Campaign {
    const r = this.#db.prepare("SELECT * FROM campaigns WHERE id = ? AND brand_id = ?").get(id, brandId) as unknown as Row | undefined;
    if (!r) throw new InputError("campaign", "no such campaign", 404);
    return this.#from(r);
  }

  #content(brandId: number, input: Record<string, unknown>, was?: Campaign) {
    const pick = <T>(key: string, check: (v: unknown) => T, fallback: T): T => (input[key] === undefined ? fallback : check(input[key]));
    const email = (field: string) => (v: unknown) => {
      const t = text(v, field, 254);
      if (t && !isEmail(t)) throw new InputError(field, "must be an email address");
      return t;
    };
    const lists = (field: string) => (v: unknown) => this.#contacts.resolveLists(brandId, v, field);
    const format = pick("format", (v) => (v === "html" ? "html" : "markdown") as "markdown" | "html", was?.format ?? "markdown");
    return {
      name: pick("name", (v) => text(v, "name", 120, { required: true }), was?.name ?? ""),
      subject: pick("subject", (v) => text(v, "subject", 300).replace(/[\r\n]+/g, " "), was?.subject ?? ""),
      preheader: pick("preheader", (v) => text(v, "preheader", 300).replace(/[\r\n]+/g, " "), was?.preheader ?? ""),
      fromName: pick("fromName", (v) => text(v, "fromName", 120).replace(/[\r\n]+/g, " "), was?.fromName ?? ""),
      fromEmail: pick("fromEmail", email("fromEmail"), was?.fromEmail ?? ""),
      replyTo: pick("replyTo", email("replyTo"), was?.replyTo ?? ""),
      html: pick("html", (v) => text(v, "html", 1_000_000), was?.html ?? ""),
      text: pick("text", (v) => text(v, "text", 500_000), was?.text ?? ""),
      source: pick("source", (v) => text(v, "source", 1_000_000), was?.source ?? ""),
      format,
      lists: pick("lists", lists("lists"), was?.lists ?? []),
      excludeLists: pick("excludeLists", lists("excludeLists"), was?.excludeLists ?? []),
    };
  }

  add(brandId: number, input: Record<string, unknown>): Campaign {
    const brand = this.#brands.must(brandId);
    const c = this.#content(brandId, { fromName: brand.fromName, fromEmail: brand.fromEmail, replyTo: brand.replyTo, ...input });
    if (!c.name) throw new InputError("name", "is required");
    const now = Date.now();
    const id = Number(
      this.#db
        .prepare("INSERT INTO campaigns (brand_id, name, subject, preheader, from_name, from_email, reply_to, html, text, source, format, lists, exclude_lists, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(brandId, c.name, c.subject, c.preheader, c.fromName, c.fromEmail, c.replyTo, c.html, c.text, c.source, c.format, JSON.stringify(c.lists), JSON.stringify(c.excludeLists), now, now).lastInsertRowid,
    );
    return this.get(brandId, id);
  }

  /** Changes a draft or a scheduled campaign (a scheduled one goes back to draft only if asked). */
  update(brandId: number, id: number, input: Record<string, unknown>): Campaign {
    const was = this.get(brandId, id);
    if (was.status !== "draft" && was.status !== "scheduled") throw new InputError("status", "a campaign that started can't be changed: duplicate it instead", 409);
    const c = this.#content(brandId, input, was);
    this.#db
      .prepare("UPDATE campaigns SET name = ?, subject = ?, preheader = ?, from_name = ?, from_email = ?, reply_to = ?, html = ?, text = ?, source = ?, format = ?, lists = ?, exclude_lists = ?, updated_at = ? WHERE id = ?")
      .run(c.name, c.subject, c.preheader, c.fromName, c.fromEmail, c.replyTo, c.html, c.text, c.source, c.format, JSON.stringify(c.lists), JSON.stringify(c.excludeLists), Date.now(), id);
    return this.get(brandId, id);
  }

  duplicate(brandId: number, id: number): Campaign {
    const c = this.get(brandId, id);
    return this.add(brandId, { ...c, name: `${c.name} (copy)`.slice(0, 120) });
  }

  remove(brandId: number, id: number): void {
    const c = this.get(brandId, id);
    if (c.status === "sending" || c.status === "paused") throw new InputError("status", "cancel the campaign first", 409);
    tx(this.#db, () => {
      this.#db.prepare("DELETE FROM events WHERE message_id IN (SELECT id FROM messages WHERE campaign_id = ?)").run(id);
      this.#db.prepare("DELETE FROM messages WHERE campaign_id = ?").run(id);
      this.#db.prepare("DELETE FROM campaigns WHERE id = ?").run(id);
    });
  }

  #audienceSql(brandId: number, lists: number[], exclude: number[]): { sql: string; args: SQLInputValue[] } {
    const marks = (n: number) => Array(n).fill("?").join(", ");
    const parts = ["c.brand_id = ?", "c.status = 'subscribed'", `EXISTS (SELECT 1 FROM list_members m WHERE m.contact_id = c.id AND m.list_id IN (${marks(lists.length)}))`, "NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.brand_id = c.brand_id AND s.email = c.email)"];
    if (exclude.length) parts.push(`NOT EXISTS (SELECT 1 FROM list_members m WHERE m.contact_id = c.id AND m.list_id IN (${marks(exclude.length)}))`);
    return { sql: parts.join(" AND "), args: [brandId, ...lists, ...exclude] };
  }

  /** How many contacts would get it now. */
  audience(brandId: number, lists: number[], exclude: number[] = []): number {
    if (!lists.length) return 0;
    const a = this.#audienceSql(brandId, lists, exclude);
    return (this.#db.prepare(`SELECT count(*) n FROM contacts c WHERE ${a.sql}`).get(...a.args) as { n: number }).n;
  }

  /** What stops a campaign from being sent, if anything. */
  problems(c: Campaign): string[] {
    const brand = this.#brands.must(c.brandId);
    const out: string[] = [];
    if (brand.provider === "none") out.push("the brand has no provider: set SMTP or Amazon SES in its settings");
    if (!c.subject) out.push("it has no subject");
    if (!c.html) out.push("it has no content");
    if (!c.fromEmail) out.push("it has no From address");
    else if (!this.#domains.verifiedFor(c.brandId, c.fromEmail)) out.push(`${c.fromEmail.split("@")[1]} isn't a verified domain of this brand`);
    if (!c.lists.length) out.push("it goes to no list");
    else if (!this.audience(c.brandId, c.lists, c.excludeLists)) out.push("its lists have no subscribed contacts");
    return out;
  }

  /** Sends now (no `at`) or at a time; the scheduler starts it when it's due. */
  schedule(brandId: number, id: number, at?: number | null): Campaign {
    const c = this.get(brandId, id);
    if (c.status !== "draft" && c.status !== "scheduled") throw new InputError("status", "only a draft can be scheduled", 409);
    const problems = this.problems(c);
    if (problems.length) throw new InputError("campaign", `It can't be sent yet: ${problems.join("; ")}.`, 409);
    const when = at ?? Date.now();
    if (!Number.isFinite(when) || when > Date.now() + 366 * 86_400_000) throw new InputError("at", "must be a time within a year");
    this.#db.prepare("UPDATE campaigns SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?").run(when, Date.now(), id);
    this.tick();
    return this.get(brandId, id);
  }

  /** Back to draft before it starts. */
  unschedule(brandId: number, id: number): Campaign {
    const c = this.get(brandId, id);
    if (c.status !== "scheduled") throw new InputError("status", "it isn't scheduled", 409);
    this.#db.prepare("UPDATE campaigns SET status = 'draft', scheduled_at = NULL, updated_at = ? WHERE id = ? AND status = 'scheduled'").run(Date.now(), id);
    return this.get(brandId, id);
  }

  pause(brandId: number, id: number, reason = "paused by hand"): Campaign {
    const c = this.get(brandId, id);
    if (c.status !== "sending") throw new InputError("status", "it isn't sending", 409);
    this.#db.prepare("UPDATE campaigns SET status = 'paused', paused_reason = ?, updated_at = ? WHERE id = ?").run(reason, Date.now(), id);
    return this.get(brandId, id);
  }

  resume(brandId: number, id: number): Campaign {
    const c = this.get(brandId, id);
    if (c.status !== "paused") throw new InputError("status", "it isn't paused", 409);
    this.#db.prepare("UPDATE campaigns SET status = 'sending', paused_reason = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id);
    return this.get(brandId, id);
  }

  /** Stops it: what wasn't sent yet never will be. */
  cancel(brandId: number, id: number): Campaign {
    const c = this.get(brandId, id);
    if (!["scheduled", "sending", "paused"].includes(c.status)) throw new InputError("status", "it isn't scheduled or sending", 409);
    const now = Date.now();
    tx(this.#db, () => {
      this.#db.prepare("UPDATE messages SET status = 'cancelled' WHERE campaign_id = ? AND status = 'queued'").run(id);
      this.#db.prepare("UPDATE campaigns SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
    });
    return this.get(brandId, id);
  }

  /** Its audience as queued messages, in one transaction. */
  #start(c: Campaign, now: number): void {
    const a = this.#audienceSql(c.brandId, c.lists, c.excludeLists);
    tx(this.#db, () => {
      const n = Number(
        this.#db
          .prepare(
            `INSERT INTO messages (id, brand_id, kind, campaign_id, contact_id, to_email, from_email, subject, status, priority, send_at, created_at)
             SELECT lower(hex(randomblob(12))), c.brand_id, 'campaign', ?, c.id, c.email, ?, ?, 'queued', 0, ?, ? FROM contacts c WHERE ${a.sql}`,
          )
          .run(c.id, c.fromEmail, c.subject.slice(0, 500), now, now, ...a.args).changes,
      );
      this.#db.prepare("UPDATE campaigns SET status = 'sending', started_at = ?, recipients = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'").run(now, n, now, c.id);
    });
  }

  /** Starts what's due, pauses what bounces too much, and finishes what's done. */
  tick(now = Date.now()): void {
    for (const r of this.#db.prepare("SELECT id, brand_id FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= ?").all(now) as { id: number; brand_id: number }[]) {
      const c = this.get(r.brand_id, r.id);
      const problems = this.problems(c);
      if (problems.length) {
        this.#db.prepare("UPDATE campaigns SET status = 'paused', paused_reason = ?, updated_at = ? WHERE id = ?").run(`It couldn't start: ${problems.join("; ")}.`, now, r.id);
        continue;
      }
      this.#start(c, now);
    }
    for (const r of this.#db.prepare("SELECT id, recipients FROM campaigns WHERE status = 'sending'").all() as { id: number; recipients: number }[]) {
      const s = this.stats(r.id, r.recipients);
      const done = s.sent + s.bounced + s.failed;
      if (done >= GUARD_AFTER && (s.bounced / done > MAX_BOUNCE || s.complained / done > MAX_COMPLAINT)) {
        const why = s.bounced / done > MAX_BOUNCE ? `${Math.round((s.bounced / done) * 1000) / 10}% of it bounced` : `${Math.round((s.complained / done) * 1000) / 10}% of it was marked as spam`;
        this.#db.prepare("UPDATE campaigns SET status = 'paused', paused_reason = ?, updated_at = ? WHERE id = ?").run(`Paused by itself: ${why}. Clean the list before resuming.`, now, r.id);
      } else if (s.queued === 0) {
        this.#db.prepare("UPDATE campaigns SET status = 'sent', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'sending'").run(now, now, r.id);
      }
    }
  }

  /** The links clicked in a campaign, most first. */
  links(brandId: number, id: number): { url: string; clicks: number; people: number }[] {
    this.get(brandId, id);
    return this.#db
      .prepare("SELECT e.detail url, count(*) clicks, count(DISTINCT e.message_id) people FROM events e JOIN messages m ON m.id = e.message_id WHERE m.campaign_id = ? AND e.kind = 'click' GROUP BY e.detail ORDER BY clicks DESC LIMIT 100")
      .all(id) as { url: string; clicks: number; people: number }[];
  }
}

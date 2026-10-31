// The forms: each a title, a slug (its address, /f/<slug>), its schema, when
// it closes (by hand, at a time, after a number of responses) and who's told
// about responses. Views and starts are counted on the form itself.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { InputError } from "../../lib/http.ts";
import { checkSchema, emptySchema, type Schema } from "./schema.ts";

export interface Notify {
  /** Who's emailed about each response (through the Email integration). */
  email: string;
  /** Respondents get a copy of their answers, at the address in this field. */
  receiptField: string;
  /** Each response is posted here as JSON, signed with the secret. */
  webhook: string;
  webhookSecret: string;
}

export interface Form {
  id: number;
  slug: string;
  title: string;
  schema: Schema;
  status: "open" | "closed";
  closeAt: number | null;
  maxResponses: number | null;
  closedMessage: string;
  notify: Notify;
  views: number;
  starts: number;
  responses: number;
  lastResponseAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: number;
  slug: string;
  title: string;
  schema: string;
  status: "open" | "closed";
  close_at: number | null;
  max_responses: number | null;
  closed_message: string;
  notify: string;
  views: number;
  starts: number;
  created_at: number;
  updated_at: number;
  responses: number;
  last_at: number | null;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const SQL = "SELECT f.*, (SELECT count(*) FROM responses r WHERE r.form_id = f.id) responses, (SELECT max(created_at) FROM responses r WHERE r.form_id = f.id) last_at FROM forms f";
const EMPTY_NOTIFY: Notify = { email: "", receiptField: "", webhook: "", webhookSecret: "" };

export class Forms {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  #from(r: Row): Form {
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      schema: JSON.parse(r.schema),
      status: r.status,
      closeAt: r.close_at,
      maxResponses: r.max_responses,
      closedMessage: r.closed_message,
      notify: { ...EMPTY_NOTIFY, ...JSON.parse(r.notify) },
      views: r.views,
      starts: r.starts,
      responses: r.responses,
      lastResponseAt: r.last_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  list(): Form[] {
    return (this.#db.prepare(`${SQL} ORDER BY f.updated_at DESC`).all() as unknown as Row[]).map((r) => this.#from(r));
  }

  get(id: number): Form {
    const r = Number.isInteger(id) ? (this.#db.prepare(`${SQL} WHERE f.id = ?`).get(id) as unknown as Row | undefined) : undefined;
    if (!r) throw new InputError("form", "no such form", 404);
    return this.#from(r);
  }

  bySlug(slug: string): Form | null {
    const r = this.#db.prepare(`${SQL} WHERE f.slug = ?`).get(slug) as unknown as Row | undefined;
    return r ? this.#from(r) : null;
  }

  add(input: Record<string, unknown>): Form {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title || title.length > 200) throw new InputError("title", "must be a title of up to 200 characters");
    if ((this.#db.prepare("SELECT count(*) n FROM forms").get() as { n: number }).n >= 1000) throw new InputError("title", "at most 1000 forms", 409);
    const schema = input.schema === undefined ? emptySchema() : checkSchema(input.schema);
    let slug = randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x");
    while (this.bySlug(slug)) slug = randomBytes(6).toString("hex");
    const now = Date.now();
    const id = Number(this.#db.prepare("INSERT INTO forms (slug, title, schema, notify, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(slug, title, JSON.stringify(schema), JSON.stringify({ ...EMPTY_NOTIFY, webhookSecret: randomBytes(24).toString("base64url") }), now, now).lastInsertRowid);
    return this.get(id);
  }

  update(id: number, input: Record<string, unknown>): Form {
    const was = this.get(id);
    let title = was.title;
    if (input.title !== undefined) {
      title = typeof input.title === "string" ? input.title.trim() : "";
      if (!title || title.length > 200) throw new InputError("title", "must be a title of up to 200 characters");
    }
    let slug = was.slug;
    if (input.slug !== undefined) {
      slug = String(input.slug).trim().toLowerCase();
      if (!SLUG.test(slug)) throw new InputError("slug", "must be lowercase letters, digits and dashes (up to 50)");
      if (slug !== was.slug && this.bySlug(slug)) throw new InputError("slug", "another form has that address", 409);
    }
    const schema = input.schema === undefined ? was.schema : checkSchema(input.schema);
    const status = input.status === undefined ? was.status : input.status === "closed" ? "closed" : "open";
    const at = (v: unknown, field: string) => {
      if (v === null || v === "") return null;
      const n = typeof v === "number" ? v : Date.parse(String(v));
      if (!Number.isFinite(n)) throw new InputError(field, "must be a date and time");
      return n;
    };
    const closeAt = input.closeAt === undefined ? was.closeAt : at(input.closeAt, "closeAt");
    let maxResponses = was.maxResponses;
    if (input.maxResponses !== undefined) {
      maxResponses = input.maxResponses === null || input.maxResponses === "" ? null : Number(input.maxResponses);
      if (maxResponses !== null && (!Number.isInteger(maxResponses) || maxResponses < 1)) throw new InputError("maxResponses", "must be a number of responses");
    }
    const closedMessage = input.closedMessage === undefined ? was.closedMessage : String(input.closedMessage).slice(0, 2000);
    let notify = was.notify;
    if (input.notify !== undefined) {
      const n = (input.notify ?? {}) as Record<string, unknown>;
      const email = typeof n.email === "string" ? n.email.trim() : was.notify.email;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new InputError("notify.email", "must be an email address");
      const webhook = typeof n.webhook === "string" ? n.webhook.trim() : was.notify.webhook;
      if (webhook && !/^https?:\/\/\S+$/.test(webhook)) throw new InputError("notify.webhook", "must be a link starting with https://");
      const receiptField = typeof n.receiptField === "string" ? n.receiptField : was.notify.receiptField;
      if (receiptField && !schema.fields.some((f) => f.id === receiptField && f.type === "email")) throw new InputError("notify.receiptField", "must be one of the form's email fields");
      notify = { email, webhook, receiptField, webhookSecret: n.newSecret === true ? randomBytes(24).toString("base64url") : was.notify.webhookSecret || randomBytes(24).toString("base64url") };
    }
    this.#db
      .prepare("UPDATE forms SET slug = ?, title = ?, schema = ?, status = ?, close_at = ?, max_responses = ?, closed_message = ?, notify = ?, updated_at = ? WHERE id = ?")
      .run(slug, title, JSON.stringify(schema), status, closeAt, maxResponses, closedMessage, JSON.stringify(notify), Date.now(), id);
    return this.get(id);
  }

  duplicate(id: number): Form {
    const f = this.get(id);
    return this.add({ title: `${f.title} (copy)`.slice(0, 200), schema: f.schema });
  }

  /** Why the form takes no answers now, or null when it's open. */
  closedBecause(f: Form, now = Date.now()): string | null {
    if (f.status === "closed") return "closed";
    if (f.closeAt !== null && now >= f.closeAt) return "past its closing time";
    if (f.maxResponses !== null && f.responses >= f.maxResponses) return "full";
    return null;
  }

  count(id: number, what: "views" | "starts"): void {
    this.#db.prepare(`UPDATE forms SET ${what} = ${what} + 1 WHERE id = ?`).run(id);
  }

  /** Deletes the form row; its responses and files go with Responses.removeAll first. */
  remove(id: number): void {
    this.get(id);
    this.#db.prepare("DELETE FROM forms WHERE id = ?").run(id);
  }
}

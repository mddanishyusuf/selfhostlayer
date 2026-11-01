// A brand's contacts and lists. A contact is an address with a name, custom
// fields and a status: subscribed, unconfirmed (double opt-in, waiting for the
// click), unsubscribed, bounced or complained. Only subscribed contacts get
// campaigns and automations. Imports and the API never resubscribe someone
// who left; the suppression list (hard bounces, complaints, addresses added
// by hand) stops every kind of email, transactional ones included.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { csvCell, csvValue, parseCsv } from "../../lib/csv.ts";
import { InputError } from "../../lib/http.ts";
import { text } from "./brands.ts";
import { tx } from "./db.ts";
import { isEmail } from "./mime.ts";
import { newId } from "../../lib/secrets.ts";

export type ContactStatus = "subscribed" | "unconfirmed" | "unsubscribed" | "bounced" | "complained";
export const STATUSES: ContactStatus[] = ["subscribed", "unconfirmed", "unsubscribed", "bounced", "complained"];

export interface Contact {
  id: number;
  brandId: number;
  email: string;
  name: string;
  fields: Record<string, string>;
  status: ContactStatus;
  source: string;
  lists: number[];
  createdAt: number;
  updatedAt: number;
  unsubscribedAt: number | null;
}

export interface List {
  id: number;
  brandId: number;
  name: string;
  description: string;
  /** For the public subscribe endpoint: /subscribe/<publicKey>. */
  publicKey: string;
  doubleOptIn: boolean;
  /** Subscribed contacts in it, and all of them. */
  subscribed: number;
  total: number;
  createdAt: number;
}

interface ContactRow {
  id: number;
  brand_id: number;
  email: string;
  name: string;
  fields: string;
  status: ContactStatus;
  source: string;
  created_at: number;
  updated_at: number;
  unsubscribed_at: number | null;
}

const FIELD = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_IMPORT = 100_000;

/** Custom fields checked: up to 30, names like company or plan_name, values up to 500 characters. */
export function checkFields(value: unknown, field = "fields"): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new InputError(field, "must map field names to values");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!FIELD.test(k)) throw new InputError(field, `${k.slice(0, 40)}: names are lowercase letters, digits and _, starting with a letter`);
    if (v === null || v === undefined || v === "") continue;
    if (!["string", "number", "boolean"].includes(typeof v)) throw new InputError(field, `${k} must be text, a number or true/false`);
    out[k] = String(v).slice(0, 500);
  }
  if (Object.keys(out).length > 30) throw new InputError(field, "at most 30 fields");
  return out;
}

export function checkEmail(value: unknown, field = "email"): string {
  if (typeof value !== "string" || !isEmail(value.trim())) throw new InputError(field, "must be an email address");
  return value.trim().toLowerCase();
}

export interface ContactsHooks {
  /** A subscribed contact joined a list (automations start here). */
  joined?: (brandId: number, listId: number, contactId: number) => void;
}

export class Contacts {
  readonly #db: DatabaseSync;
  hooks: ContactsHooks = {};

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  // Lists

  #list(r: { id: number; brand_id: number; name: string; description: string; public_key: string; double_opt_in: number; created_at: number; subscribed: number; total: number }): List {
    return { id: r.id, brandId: r.brand_id, name: r.name, description: r.description, publicKey: r.public_key, doubleOptIn: r.double_opt_in === 1, subscribed: r.subscribed, total: r.total, createdAt: r.created_at };
  }

  #listSql = `SELECT l.*, (SELECT count(*) FROM list_members m JOIN contacts c ON c.id = m.contact_id WHERE m.list_id = l.id AND c.status = 'subscribed') subscribed,
                (SELECT count(*) FROM list_members m WHERE m.list_id = l.id) total FROM lists l`;

  lists(brandId: number): List[] {
    return (this.#db.prepare(`${this.#listSql} WHERE l.brand_id = ? ORDER BY l.name COLLATE NOCASE`).all(brandId) as never[]).map((r) => this.#list(r));
  }

  list(brandId: number, id: number): List {
    const r = this.#db.prepare(`${this.#listSql} WHERE l.id = ? AND l.brand_id = ?`).get(id, brandId) as never;
    if (!r) throw new InputError("list", "no such list", 404);
    return this.#list(r);
  }

  listByKey(publicKey: string): List | null {
    const r = this.#db.prepare(`${this.#listSql} WHERE l.public_key = ?`).get(publicKey) as never;
    return r ? this.#list(r) : null;
  }

  addList(brandId: number, input: Record<string, unknown>): List {
    const name = text(input.name, "name", 80, { required: true });
    if ((this.#db.prepare("SELECT count(*) n FROM lists WHERE brand_id = ?").get(brandId) as { n: number }).n >= 200) throw new InputError("name", "at most 200 lists", 409);
    const id = Number(
      this.#db
        .prepare("INSERT INTO lists (brand_id, name, description, public_key, double_opt_in, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(brandId, name, text(input.description, "description", 300), newId(9), input.doubleOptIn === true ? 1 : 0, Date.now()).lastInsertRowid,
    );
    return this.list(brandId, id);
  }

  updateList(brandId: number, id: number, input: Record<string, unknown>): List {
    const was = this.list(brandId, id);
    this.#db
      .prepare("UPDATE lists SET name = ?, description = ?, double_opt_in = ? WHERE id = ?")
      .run(
        input.name === undefined ? was.name : text(input.name, "name", 80, { required: true }),
        input.description === undefined ? was.description : text(input.description, "description", 300),
        input.doubleOptIn === undefined ? (was.doubleOptIn ? 1 : 0) : input.doubleOptIn === true ? 1 : 0,
        id,
      );
    return this.list(brandId, id);
  }

  /** Deletes the list; its contacts stay. */
  removeList(brandId: number, id: number): void {
    this.list(brandId, id);
    tx(this.#db, () => {
      this.#db.prepare("DELETE FROM list_members WHERE list_id = ?").run(id);
      this.#db.prepare("DELETE FROM lists WHERE id = ?").run(id);
    });
  }

  /** Lists by id or name (the API takes either), all of this brand's. */
  resolveLists(brandId: number, value: unknown, field = "lists"): number[] {
    if (value === undefined || value === null) return [];
    const items = Array.isArray(value) ? value : [value];
    if (items.length > 50) throw new InputError(field, "at most 50 lists");
    return items.map((v) => {
      const r = (typeof v === "number" ? this.#db.prepare("SELECT id FROM lists WHERE brand_id = ? AND id = ?").get(brandId, v) : this.#db.prepare("SELECT id FROM lists WHERE brand_id = ? AND (name = ? COLLATE NOCASE OR CAST(id AS TEXT) = ?)").get(brandId, String(v), String(v))) as
        | { id: number }
        | undefined;
      if (!r) throw new InputError(field, `no list ${String(v).slice(0, 80)}`, 404);
      return r.id;
    });
  }

  // Contacts

  #from(r: ContactRow): Contact {
    const lists = (this.#db.prepare("SELECT list_id FROM list_members WHERE contact_id = ? ORDER BY list_id").all(r.id) as { list_id: number }[]).map((x) => x.list_id);
    return { id: r.id, brandId: r.brand_id, email: r.email, name: r.name, fields: JSON.parse(r.fields), status: r.status, source: r.source, lists, createdAt: r.created_at, updatedAt: r.updated_at, unsubscribedAt: r.unsubscribed_at };
  }

  get(brandId: number, id: number): Contact {
    const r = this.#db.prepare("SELECT * FROM contacts WHERE id = ? AND brand_id = ?").get(id, brandId) as unknown as ContactRow | undefined;
    if (!r) throw new InputError("contact", "no such contact", 404);
    return this.#from(r);
  }

  byEmail(brandId: number, email: string): Contact | null {
    const r = this.#db.prepare("SELECT * FROM contacts WHERE brand_id = ? AND email = ?").get(brandId, email.toLowerCase()) as unknown as ContactRow | undefined;
    return r ? this.#from(r) : null;
  }

  search(brandId: number, o: { q?: string; list?: number; status?: string; page?: number } = {}): { contacts: Contact[]; total: number; page: number; pageSize: number } {
    const parts = ["c.brand_id = ?"];
    const args: SQLInputValue[] = [brandId];
    if (o.q?.trim()) {
      parts.push("(c.email LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')");
      const like = `%${o.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      args.push(like, like);
    }
    if (o.list) {
      parts.push("EXISTS (SELECT 1 FROM list_members m WHERE m.contact_id = c.id AND m.list_id = ?)");
      args.push(o.list);
    }
    if (o.status && (STATUSES as string[]).includes(o.status)) {
      parts.push("c.status = ?");
      args.push(o.status);
    }
    const where = parts.join(" AND ");
    const total = (this.#db.prepare(`SELECT count(*) n FROM contacts c WHERE ${where}`).get(...args) as { n: number }).n;
    const pageSize = 50;
    const page = Math.max(1, Math.min(o.page ?? 1, Math.ceil(total / pageSize) || 1));
    const rows = this.#db.prepare(`SELECT c.* FROM contacts c WHERE ${where} ORDER BY c.created_at DESC, c.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`).all(...args) as unknown as ContactRow[];
    return { contacts: rows.map((r) => this.#from(r)), total, page, pageSize };
  }

  /**
   * Adds or updates a contact by email. Fields merge; a name replaces. A
   * contact who unsubscribed, bounced or complained stays so unless `status`
   * says otherwise and `resubscribe` allows it (the panel, the API's explicit
   * choice), never from an import. Joining lists fires the hook for subscribed
   * contacts only.
   */
  upsert(brandId: number, input: Record<string, unknown>, o: { resubscribe?: boolean; source?: string } = {}): { contact: Contact; created: boolean } {
    const email = checkEmail(input.email);
    const name = input.name === undefined ? undefined : text(input.name, "name", 200).replace(/[\r\n]+/g, " ");
    const fields = checkFields(input.fields);
    let status = input.status as ContactStatus | undefined;
    if (status !== undefined && !STATUSES.includes(status)) throw new InputError("status", `must be one of ${STATUSES.join(", ")}`);
    const lists = this.resolveLists(brandId, input.lists);
    const now = Date.now();
    const was = this.byEmail(brandId, email);
    let id: number;
    tx(this.#db, () => {
      if (!was) {
        if (this.#db.prepare("SELECT 1 FROM suppressions WHERE brand_id = ? AND email = ?").get(brandId, email) && (status === undefined || status === "subscribed")) status = "unsubscribed";
        id = Number(
          this.#db
            .prepare("INSERT INTO contacts (brand_id, email, name, fields, status, source, created_at, updated_at, unsubscribed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(brandId, email, name ?? "", JSON.stringify(fields), status ?? "subscribed", o.source ?? "", now, now, status === "unsubscribed" ? now : null).lastInsertRowid,
        );
      } else {
        id = was.id;
        const left = was.status === "unsubscribed" || was.status === "bounced" || was.status === "complained";
        const next = status === undefined || (left && status === "subscribed" && !o.resubscribe) ? was.status : status;
        this.#db
          .prepare("UPDATE contacts SET name = ?, fields = ?, status = ?, updated_at = ?, unsubscribed_at = CASE WHEN ? = 'unsubscribed' AND unsubscribed_at IS NULL THEN ? WHEN ? = 'subscribed' THEN NULL ELSE unsubscribed_at END WHERE id = ?")
          .run(name ?? was.name, JSON.stringify({ ...was.fields, ...fields }), next, now, next, now, next, id);
      }
      for (const listId of lists) this.#join(brandId, id, listId, now);
    });
    return { contact: this.get(brandId, id!), created: !was };
  }

  /** Adds to a list; a subscribed contact who's new to it starts its automations, unless `hook` is false (imports). */
  #join(brandId: number, contactId: number, listId: number, now = Date.now(), hook = true): boolean {
    const added = Number(this.#db.prepare("INSERT OR IGNORE INTO list_members (list_id, contact_id, added_at) VALUES (?, ?, ?)").run(listId, contactId, now).changes) > 0;
    if (added && hook) {
      const status = (this.#db.prepare("SELECT status FROM contacts WHERE id = ?").get(contactId) as { status: string }).status;
      if (status === "subscribed") this.hooks.joined?.(brandId, listId, contactId);
    }
    return added;
  }

  addToList(brandId: number, contactId: number, listId: number): boolean {
    this.get(brandId, contactId);
    this.list(brandId, listId);
    return this.#join(brandId, contactId, listId);
  }

  removeFromList(brandId: number, contactId: number, listId: number): void {
    this.#db.prepare("DELETE FROM list_members WHERE list_id = ? AND contact_id = ? AND list_id IN (SELECT id FROM lists WHERE brand_id = ?)").run(listId, contactId, brandId);
  }

  update(brandId: number, id: number, input: Record<string, unknown>): Contact {
    const was = this.get(brandId, id);
    if (input.email !== undefined && checkEmail(input.email) !== was.email && this.byEmail(brandId, checkEmail(input.email))) throw new InputError("email", "another contact has that address", 409);
    const status = (input.status ?? was.status) as ContactStatus;
    if (!STATUSES.includes(status)) throw new InputError("status", `must be one of ${STATUSES.join(", ")}`);
    const now = Date.now();
    this.#db
      .prepare("UPDATE contacts SET email = ?, name = ?, fields = ?, status = ?, updated_at = ?, unsubscribed_at = CASE WHEN ? = 'unsubscribed' THEN coalesce(unsubscribed_at, ?) WHEN ? = 'subscribed' THEN NULL ELSE unsubscribed_at END WHERE id = ?")
      .run(input.email === undefined ? was.email : checkEmail(input.email), input.name === undefined ? was.name : text(input.name, "name", 200), JSON.stringify(input.fields === undefined ? was.fields : checkFields(input.fields)), status, now, status, now, status, id);
    if (status === "subscribed" && was.status !== "subscribed") {
      this.#db.prepare("DELETE FROM suppressions WHERE brand_id = ? AND email = ? AND reason = 'manual'").run(brandId, was.email);
      for (const listId of was.lists) this.hooks.joined?.(brandId, listId, id);
    }
    return this.get(brandId, id);
  }

  remove(brandId: number, id: number): void {
    this.get(brandId, id);
    tx(this.#db, () => {
      this.#db.prepare("DELETE FROM list_members WHERE contact_id = ?").run(id);
      this.#db.prepare("UPDATE automation_runs SET status = 'exited', finished_at = ? WHERE contact_id = ? AND status = 'active'").run(Date.now(), id);
      this.#db.prepare("DELETE FROM contacts WHERE id = ?").run(id);
    });
  }

  /** A contact confirmed (double opt-in): subscribed now, and the lists they're in start their automations. */
  confirm(brandId: number, id: number): Contact {
    const c = this.get(brandId, id);
    if (c.status !== "unconfirmed") return c;
    this.#db.prepare("UPDATE contacts SET status = 'subscribed', updated_at = ? WHERE id = ?").run(Date.now(), id);
    for (const listId of c.lists) this.hooks.joined?.(brandId, listId, id);
    return this.get(brandId, id);
  }

  /**
   * Back on the brand's lists after unsubscribing, from the link sent when they
   * asked to rejoin at `asked`: not if they unsubscribed again after that, or
   * the address is suppressed.
   */
  rejoin(brandId: number, id: number, asked: number): Contact {
    const c = this.get(brandId, id);
    if (c.status !== "unsubscribed" || this.isSuppressed(brandId, c.email)) return c;
    const left = (this.#db.prepare("SELECT unsubscribed_at FROM contacts WHERE id = ?").get(id) as { unsubscribed_at: number | null }).unsubscribed_at;
    if (left !== null && left > asked) return c;
    return this.update(brandId, id, { status: "subscribed" });
  }

  /** Unsubscribes by address (a link in an email, the API); true when they were subscribed. */
  unsubscribe(brandId: number, email: string, now = Date.now()): boolean {
    const r = this.#db.prepare("UPDATE contacts SET status = 'unsubscribed', unsubscribed_at = ?, updated_at = ? WHERE brand_id = ? AND email = ? AND status IN ('subscribed', 'unconfirmed')").run(now, now, brandId, email.toLowerCase());
    if (Number(r.changes)) this.#db.prepare("UPDATE automation_runs SET status = 'exited', finished_at = ? WHERE status = 'active' AND contact_id = (SELECT id FROM contacts WHERE brand_id = ? AND email = ?)").run(now, brandId, email.toLowerCase());
    return Number(r.changes) > 0;
  }

  // Suppressions

  /** No more email of any kind to this address from the brand; the contact, if any, is marked so. */
  suppress(brandId: number, email: string, reason: "bounce" | "complaint" | "manual", detail = ""): void {
    const now = Date.now();
    const address = email.toLowerCase();
    tx(this.#db, () => {
      this.#db.prepare("INSERT INTO suppressions (brand_id, email, reason, detail, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET reason = excluded.reason, detail = excluded.detail").run(brandId, address, reason, detail.slice(0, 500), now);
      const status = reason === "bounce" ? "bounced" : reason === "complaint" ? "complained" : "unsubscribed";
      this.#db.prepare("UPDATE contacts SET status = ?, updated_at = ?, unsubscribed_at = coalesce(unsubscribed_at, ?) WHERE brand_id = ? AND email = ?").run(status, now, now, brandId, address);
      this.#db.prepare("UPDATE automation_runs SET status = 'exited', finished_at = ? WHERE status = 'active' AND contact_id = (SELECT id FROM contacts WHERE brand_id = ? AND email = ?)").run(now, brandId, address);
    });
  }

  isSuppressed(brandId: number, email: string): boolean {
    return this.#db.prepare("SELECT 1 FROM suppressions WHERE brand_id = ? AND email = ?").get(brandId, email.toLowerCase()) !== undefined;
  }

  suppressions(brandId: number, page = 1): { items: { email: string; reason: string; detail: string; createdAt: number }[]; total: number } {
    const total = (this.#db.prepare("SELECT count(*) n FROM suppressions WHERE brand_id = ?").get(brandId) as { n: number }).n;
    const items = this.#db.prepare(`SELECT email, reason, detail, created_at createdAt FROM suppressions WHERE brand_id = ? ORDER BY created_at DESC LIMIT 100 OFFSET ${(Math.max(1, page) - 1) * 100}`).all(brandId) as never[];
    return { items, total };
  }

  unsuppress(brandId: number, email: string): void {
    if (!Number(this.#db.prepare("DELETE FROM suppressions WHERE brand_id = ? AND email = ?").run(brandId, email.toLowerCase()).changes)) throw new InputError("email", "isn't suppressed", 404);
  }

  // CSV

  /**
   * Contacts from a CSV: email (or e-mail, email address), name (or first and
   * last name), and every other column as a custom field. Existing contacts
   * get the new name and fields; nobody who left is resubscribed, and nobody
   * imported starts an automation.
   */
  importCsv(brandId: number, csv: string, o: { lists?: unknown; status?: unknown } = {}): { created: number; updated: number; skipped: { line: number; reason: string }[] } {
    const [header, ...raw] = parseCsv(csv);
    if (!header) throw new InputError("csv", "the file is empty");
    const rows = raw.map((r) => r.map(csvValue));
    if (rows.length > MAX_IMPORT) throw new InputError("csv", `at most ${MAX_IMPORT.toLocaleString("en")} contacts at a time`);
    const names = header.map((h) => h.trim().toLowerCase());
    const at = (aliases: string[]) => names.findIndex((n) => aliases.includes(n));
    const emailAt = at(["email", "e-mail", "email address", "email_address", "mail"]);
    if (emailAt < 0) throw new InputError("csv", "no email column (named email, e-mail or email address)");
    const nameAt = at(["name", "full name", "full_name", "fullname"]);
    const firstAt = at(["first name", "first_name", "firstname", "given name"]);
    const lastAt = at(["last name", "last_name", "lastname", "surname", "family name"]);
    const skip = new Set([emailAt, nameAt, firstAt, lastAt, at(["status", "lists", "created_at"])]);
    const fieldCols = names.map((n, i) => ({ i, key: n.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "f_$1").slice(0, 40) })).filter((c) => !skip.has(c.i) && FIELD.test(c.key));
    const lists = this.resolveLists(brandId, o.lists);
    const status = o.status === "unsubscribed" ? "unsubscribed" : undefined;
    let created = 0;
    let updated = 0;
    const skipped: { line: number; reason: string }[] = [];
    tx(this.#db, () => {
      rows.forEach((row, i) => {
        const email = row[emailAt]?.trim() ?? "";
        if (!isEmail(email)) return void skipped.push({ line: i + 2, reason: email ? `${email.slice(0, 80)} isn't an email address` : "no email" });
        const name = nameAt >= 0 ? (row[nameAt] ?? "").trim() : [firstAt >= 0 ? row[firstAt] : "", lastAt >= 0 ? row[lastAt] : ""].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
        const fields = Object.fromEntries(fieldCols.slice(0, 30).map((c) => [c.key, (row[c.i] ?? "").trim().slice(0, 500)]).filter(([, v]) => v));
        try {
          const r = this.#upsertInTx(brandId, { email: email.toLowerCase(), name: name.slice(0, 200), fields, status, lists });
          if (r) created++;
          else updated++;
        } catch (err) {
          skipped.push({ line: i + 2, reason: (err as Error).message });
        }
      });
    });
    return { created, updated, skipped: skipped.slice(0, 200) };
  }

  /** upsert's work for imports, inside their one transaction; true when created. */
  #upsertInTx(brandId: number, c: { email: string; name: string; fields: Record<string, string>; status?: ContactStatus; lists: number[] }): boolean {
    const now = Date.now();
    const was = this.#db.prepare("SELECT id, name, fields FROM contacts WHERE brand_id = ? AND email = ?").get(brandId, c.email) as { id: number; name: string; fields: string } | undefined;
    let id: number;
    if (was) {
      id = was.id;
      this.#db.prepare("UPDATE contacts SET name = ?, fields = ?, updated_at = ?, status = CASE WHEN ? IS NOT NULL THEN ? ELSE status END WHERE id = ?").run(c.name || was.name, JSON.stringify({ ...JSON.parse(was.fields), ...c.fields }), now, c.status ?? null, c.status ?? null, id);
    } else {
      const suppressed = this.#db.prepare("SELECT 1 FROM suppressions WHERE brand_id = ? AND email = ?").get(brandId, c.email) !== undefined;
      const status = c.status ?? (suppressed ? "unsubscribed" : "subscribed");
      id = Number(this.#db.prepare("INSERT INTO contacts (brand_id, email, name, fields, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'import', ?, ?)").run(brandId, c.email, c.name, JSON.stringify(c.fields), status, now, now).lastInsertRowid);
    }
    // Importing a list someone already has shouldn't send everyone the welcome series.
    for (const listId of c.lists) this.#join(brandId, id, listId, now, false);
    return !was;
  }

  exportCsv(brandId: number, o: { list?: number; status?: string } = {}): string {
    const parts = ["c.brand_id = ?"];
    const args: SQLInputValue[] = [brandId];
    if (o.list) {
      parts.push("EXISTS (SELECT 1 FROM list_members m WHERE m.contact_id = c.id AND m.list_id = ?)");
      args.push(o.list);
    }
    if (o.status && (STATUSES as string[]).includes(o.status)) {
      parts.push("c.status = ?");
      args.push(o.status);
    }
    const rows = this.#db
      .prepare(`SELECT c.*, (SELECT group_concat(l.name, '|') FROM list_members m JOIN lists l ON l.id = m.list_id WHERE m.contact_id = c.id) list_names FROM contacts c WHERE ${parts.join(" AND ")} ORDER BY c.id`)
      .all(...args) as unknown as (ContactRow & { list_names: string | null })[];
    const keys = [...new Set(rows.flatMap((r) => Object.keys(JSON.parse(r.fields) as object)))].sort();
    const head = ["email", "name", "status", "lists", "created_at", ...keys];
    const lines = rows.map((r) => {
      const f = JSON.parse(r.fields) as Record<string, string>;
      return [r.email, r.name, r.status, r.list_names ?? "", new Date(r.created_at).toISOString(), ...keys.map((k) => f[k] ?? "")].map(csvCell).join(",");
    });
    return `${[head.join(","), ...lines].join("\n")}\n`;
  }

  /** Counts for a brand's Overview. */
  counts(brandId: number): Record<ContactStatus | "total", number> {
    const out = { total: 0, subscribed: 0, unconfirmed: 0, unsubscribed: 0, bounced: 0, complained: 0 };
    for (const r of this.#db.prepare("SELECT status, count(*) n FROM contacts WHERE brand_id = ? GROUP BY status").all(brandId) as { status: ContactStatus; n: number }[]) {
      out[r.status] = r.n;
      out.total += r.n;
    }
    return out;
  }
}

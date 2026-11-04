// Automations: a trigger and steps. A subscribed contact joining a list, or an
// event sent to the API (POST /events: signed_up, trial_ending…), starts a
// run, once per contact and automation. A run goes step by step: wait, send an
// email, add to a list, remove from a list; it stops at a wait and goes on
// when it's due. A contact who unsubscribes, bounces or complains leaves.
import type { DatabaseSync } from "node:sqlite";
import { InputError } from "../../lib/http.ts";
import { text, type Brands } from "./brands.ts";
import type { Contacts } from "./contacts.ts";
import type { Domains } from "./domains.ts";
import type { Mailer } from "./mailer.ts";
import { isEmail } from "./mime.ts";

export type Step =
  | { type: "wait"; minutes: number }
  | { type: "email"; subject: string; preheader: string; html: string; text: string; source: string; format: "markdown" | "html"; fromName: string; fromEmail: string }
  | { type: "add_to_list"; listId: number }
  | { type: "remove_from_list"; listId: number };

export interface Automation {
  id: number;
  brandId: number;
  name: string;
  trigger: "list" | "event";
  /** The list's id, or the event's name. */
  triggerValue: string;
  steps: Step[];
  status: "draft" | "active" | "paused";
  createdAt: number;
  updatedAt: number;
  runs: { active: number; done: number; exited: number; failed: number };
}

export interface Run {
  id: number;
  contactId: number;
  email: string;
  step: number;
  status: "active" | "done" | "exited" | "failed";
  nextAt: number;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

interface Row {
  id: number;
  brand_id: number;
  name: string;
  trigger: "list" | "event";
  trigger_value: string;
  steps: string;
  status: "draft" | "active" | "paused";
  created_at: number;
  updated_at: number;
}

const EVENT = /^[A-Za-z0-9_.:-]{1,60}$/;
const MAX_WAIT = 365 * 24 * 60;

export class Automations {
  readonly #db: DatabaseSync;
  readonly #brands: Brands;
  readonly #domains: Domains;
  readonly #contacts: Contacts;
  readonly #mailer: Mailer;

  constructor(o: { db: DatabaseSync; brands: Brands; domains: Domains; contacts: Contacts; mailer: Mailer }) {
    this.#db = o.db;
    this.#brands = o.brands;
    this.#domains = o.domains;
    this.#contacts = o.contacts;
    this.#mailer = o.mailer;
  }

  #from(r: Row): Automation {
    const runs = { active: 0, done: 0, exited: 0, failed: 0 };
    for (const x of this.#db.prepare("SELECT status, count(*) n FROM automation_runs WHERE automation_id = ? GROUP BY status").all(r.id) as { status: keyof typeof runs; n: number }[]) runs[x.status] = x.n;
    return { id: r.id, brandId: r.brand_id, name: r.name, trigger: r.trigger, triggerValue: r.trigger_value, steps: JSON.parse(r.steps), status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, runs };
  }

  list(brandId: number): Automation[] {
    return (this.#db.prepare("SELECT * FROM automations WHERE brand_id = ? ORDER BY name COLLATE NOCASE").all(brandId) as unknown as Row[]).map((r) => this.#from(r));
  }

  get(brandId: number, id: number): Automation {
    const r = this.#db.prepare("SELECT * FROM automations WHERE id = ? AND brand_id = ?").get(id, brandId) as unknown as Row | undefined;
    if (!r) throw new InputError("automation", "no such automation", 404);
    return this.#from(r);
  }

  /** Steps checked; emails need a subject and content, lists must be the brand's. */
  #steps(brandId: number, value: unknown): Step[] {
    if (!Array.isArray(value)) throw new InputError("steps", "must be a list of steps");
    if (value.length > 50) throw new InputError("steps", "at most 50 steps");
    return value.map((s: Record<string, unknown>, i) => {
      const f = `steps[${i}]`;
      if (typeof s !== "object" || s === null) throw new InputError(f, "must be a step");
      if (s.type === "wait") {
        const minutes = Number(s.minutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_WAIT) throw new InputError(`${f}.minutes`, "must be 1 minute to 365 days");
        return { type: "wait", minutes };
      }
      if (s.type === "email") {
        const fromEmail = text(s.fromEmail, `${f}.fromEmail`, 254);
        if (fromEmail && !isEmail(fromEmail)) throw new InputError(`${f}.fromEmail`, "must be an email address");
        return {
          type: "email",
          subject: text(s.subject, `${f}.subject`, 300, { required: true }).replace(/[\r\n]+/g, " "),
          preheader: text(s.preheader, `${f}.preheader`, 300).replace(/[\r\n]+/g, " "),
          html: text(s.html, `${f}.html`, 1_000_000, { required: true }),
          text: text(s.text, `${f}.text`, 500_000),
          source: text(s.source, `${f}.source`, 1_000_000),
          format: s.format === "html" ? "html" : "markdown",
          fromName: text(s.fromName, `${f}.fromName`, 120).replace(/[\r\n]+/g, " "),
          fromEmail,
        };
      }
      if (s.type === "add_to_list" || s.type === "remove_from_list") return { type: s.type, listId: this.#contacts.resolveLists(brandId, [s.listId], `${f}.listId`)[0]! };
      throw new InputError(`${f}.type`, "must be wait, email, add_to_list or remove_from_list");
    });
  }

  #trigger(brandId: number, input: Record<string, unknown>, was?: Automation): { trigger: "list" | "event"; value: string } {
    const trigger = (input.trigger ?? was?.trigger) as "list" | "event";
    if (trigger === "list") return { trigger, value: String(this.#contacts.resolveLists(brandId, [input.triggerValue ?? was?.triggerValue], "triggerValue")[0]) };
    if (trigger === "event") {
      const value = String(input.triggerValue ?? was?.triggerValue ?? "").trim();
      if (!EVENT.test(value)) throw new InputError("triggerValue", "must be an event's name: letters, digits and _ . : -");
      return { trigger, value };
    }
    throw new InputError("trigger", "must be list or event");
  }

  add(brandId: number, input: Record<string, unknown>): Automation {
    this.#brands.must(brandId);
    const name = text(input.name, "name", 120, { required: true });
    const t = this.#trigger(brandId, input);
    const steps = this.#steps(brandId, input.steps ?? []);
    const now = Date.now();
    const id = Number(this.#db.prepare("INSERT INTO automations (brand_id, name, trigger, trigger_value, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(brandId, name, t.trigger, t.value, JSON.stringify(steps), now, now).lastInsertRowid);
    return this.get(brandId, id);
  }

  update(brandId: number, id: number, input: Record<string, unknown>): Automation {
    const was = this.get(brandId, id);
    const t = input.trigger !== undefined || input.triggerValue !== undefined ? this.#trigger(brandId, input, was) : { trigger: was.trigger, value: was.triggerValue };
    const steps = input.steps === undefined ? was.steps : this.#steps(brandId, input.steps);
    this.#db
      .prepare("UPDATE automations SET name = ?, trigger = ?, trigger_value = ?, steps = ?, updated_at = ? WHERE id = ?")
      .run(input.name === undefined ? was.name : text(input.name, "name", 120, { required: true }), t.trigger, t.value, JSON.stringify(steps), Date.now(), id);
    return this.get(brandId, id);
  }

  /** Active (it starts runs and they go on) or paused (runs wait where they are). */
  setStatus(brandId: number, id: number, status: unknown): Automation {
    const a = this.get(brandId, id);
    if (status !== "active" && status !== "paused") throw new InputError("status", "must be active or paused");
    if (status === "active") {
      if (!a.steps.length) throw new InputError("steps", "add a step first", 409);
      for (const s of a.steps) {
        if (s.type !== "email") continue;
        const from = s.fromEmail || this.#brands.must(brandId).fromEmail;
        if (!from) throw new InputError("steps", "an email step has no From address, and the brand has no default", 409);
        if (!this.#domains.verifiedFor(brandId, from)) throw new InputError("steps", `${from.split("@")[1]} isn't a verified domain of this brand`, 409);
      }
    }
    this.#db.prepare("UPDATE automations SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
    return this.get(brandId, id);
  }

  remove(brandId: number, id: number): void {
    this.get(brandId, id);
    this.#db.prepare("DELETE FROM automation_runs WHERE automation_id = ?").run(id);
    this.#db.prepare("DELETE FROM automations WHERE id = ?").run(id);
  }

  runs(brandId: number, id: number, page = 1): { runs: Run[]; total: number } {
    this.get(brandId, id);
    const total = (this.#db.prepare("SELECT count(*) n FROM automation_runs WHERE automation_id = ?").get(id) as { n: number }).n;
    const runs = this.#db
      .prepare(
        `SELECT r.id, r.contact_id contactId, coalesce(c.email, '(deleted)') email, r.step, r.status, r.next_at nextAt, r.error, r.started_at startedAt, r.finished_at finishedAt
         FROM automation_runs r LEFT JOIN contacts c ON c.id = r.contact_id WHERE r.automation_id = ? ORDER BY r.started_at DESC, r.id DESC LIMIT 50 OFFSET ${(Math.max(1, page) - 1) * 50}`,
      )
      .all(id) as unknown as Run[];
    return { runs, total };
  }

  #start(automationId: number, contactId: number, data: unknown, now: number): boolean {
    if (this.#db.prepare("SELECT 1 FROM automation_runs WHERE automation_id = ? AND contact_id = ?").get(automationId, contactId)) return false;
    this.#db.prepare("INSERT INTO automation_runs (automation_id, contact_id, next_at, data, started_at) VALUES (?, ?, ?, ?, ?)").run(automationId, contactId, now, data === undefined ? null : JSON.stringify(data), now);
    return true;
  }

  /** A subscribed contact joined a list. */
  onListJoin(brandId: number, listId: number, contactId: number): void {
    const now = Date.now();
    for (const a of this.#db.prepare("SELECT id FROM automations WHERE brand_id = ? AND status = 'active' AND trigger = 'list' AND trigger_value = ?").all(brandId, String(listId)) as { id: number }[]) this.#start(a.id, contactId, undefined, now);
  }

  /** An event from the API, for a contact (added, subscribed, when new). Returns how many automations it started. */
  onEvent(brandId: number, input: Record<string, unknown>): { started: number; contactId: number } {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!EVENT.test(name)) throw new InputError("name", "must be an event's name: letters, digits and _ . : -");
    if (input.data !== undefined && (typeof input.data !== "object" || input.data === null || Array.isArray(input.data))) throw new InputError("data", "must be an object");
    if (JSON.stringify(input.data ?? {}).length > 10_000) throw new InputError("data", "must be under 10 KB");
    const { contact } = this.#contacts.upsert(brandId, { email: input.email }, { source: "event" });
    if (contact.status !== "subscribed" || contact.flags) return { started: 0, contactId: contact.id };
    const now = Date.now();
    let started = 0;
    for (const a of this.#db.prepare("SELECT id FROM automations WHERE brand_id = ? AND status = 'active' AND trigger = 'event' AND trigger_value = ?").all(brandId, name) as { id: number }[]) {
      if (this.#start(a.id, contact.id, input.data ?? {}, now)) started++;
    }
    return { started, contactId: contact.id };
  }

  /** Moves due runs along; returns how many it looked at. */
  tick(now = Date.now()): number {
    const db = this.#db;
    const due = db
      .prepare(
        `UPDATE automation_runs SET claimed_until = ? WHERE id IN (
           SELECT r.id FROM automation_runs r JOIN automations a ON a.id = r.automation_id
           WHERE r.status = 'active' AND r.next_at <= ? AND (r.claimed_until IS NULL OR r.claimed_until < ?) AND a.status = 'active' LIMIT 200)
         RETURNING id, automation_id, contact_id, step, data`,
      )
      .all(now + 5 * 60_000, now, now) as { id: number; automation_id: number; contact_id: number; step: number; data: string | null }[];
    for (const run of due) this.#advance(run, now);
    return due.length;
  }

  #finish(id: number, status: "done" | "exited" | "failed", now: number, error?: string): void {
    this.#db.prepare("UPDATE automation_runs SET status = ?, finished_at = ?, error = ?, claimed_until = NULL WHERE id = ?").run(status, now, error ?? null, id);
  }

  #advance(run: { id: number; automation_id: number; contact_id: number; step: number; data: string | null }, now: number): void {
    const a = this.#db.prepare("SELECT * FROM automations WHERE id = ?").get(run.automation_id) as unknown as Row;
    const steps = JSON.parse(a.steps) as Step[];
    for (let i = run.step; i < steps.length; i++) {
      const contact = this.#db.prepare("SELECT id, email, name, fields, status, flags FROM contacts WHERE id = ?").get(run.contact_id) as { id: number; email: string; name: string; fields: string; status: string; flags: string | null } | undefined;
      if (!contact || contact.status !== "subscribed" || contact.flags) return this.#finish(run.id, "exited", now);
      const s = steps[i]!;
      try {
        if (s.type === "wait") {
          this.#db.prepare("UPDATE automation_runs SET step = ?, next_at = ?, claimed_until = NULL WHERE id = ?").run(i + 1, now + s.minutes * 60_000, run.id);
          return;
        }
        if (s.type === "email") {
          const brand = this.#brands.must(a.brand_id);
          const fromEmail = s.fromEmail || brand.fromEmail;
          const fromName = s.fromName || brand.fromName;
          this.#mailer.queueMarketing({
            brandId: a.brand_id,
            kind: "automation",
            automationId: a.id,
            contact: { id: contact.id, email: contact.email, name: contact.name, fields: JSON.parse(contact.fields) },
            from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
            replyTo: brand.replyTo || undefined,
            subject: s.subject,
            preheader: s.preheader,
            html: s.html,
            text: s.text,
            vars: { data: run.data ? JSON.parse(run.data) : {} },
          });
        } else if (s.type === "add_to_list") this.#contacts.addToList(a.brand_id, contact.id, s.listId);
        else this.#contacts.removeFromList(a.brand_id, contact.id, s.listId);
        this.#db.prepare("UPDATE automation_runs SET step = ? WHERE id = ?").run(i + 1, run.id);
      } catch (err) {
        return this.#finish(run.id, "failed", now, (err as Error).message);
      }
    }
    this.#finish(run.id, "done", now);
  }
}

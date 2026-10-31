// Telling people about a response, after it's kept (never holding it up):
//   webhook  the response as JSON to the form's URL, signed with its secret
//            (X-Forms-Signature: sha256=<hex HMAC of the body>);
//   email    the owner's address, and a copy to the respondent, sent through
//            the Email integration's API (Forms keeps no SMTP of its own: the
//            panel gives it Email's address, a key and a From).
// Each is tried again after 1 minute, 10 minutes and an hour.
import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { InputError } from "../../lib/http.ts";
import type { Secrets } from "../../lib/secrets.ts";
import { getSetting, setSetting } from "./db.ts";
import type { Form, Forms } from "./forms.ts";
import type { Response, Responses } from "./responses.ts";
import { answerText, NO_ANSWER } from "./schema.ts";

export interface EmailConfig {
  /** Email's public address, like https://email.example.com. */
  url: string;
  from: string;
  brand: string;
}

const RETRY = [60_000, 10 * 60_000, 60 * 60_000];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The response as the webhook sends it: by id, and as a list with labels. */
export function payload(form: Form, r: Response): Record<string, unknown> {
  return {
    form: { id: form.id, slug: form.slug, title: form.title },
    response: {
      id: r.id,
      createdAt: new Date(r.createdAt).toISOString(),
      answers: r.answers,
      fields: form.schema.fields.filter((f) => !NO_ANSWER.includes(f.type)).map((f) => ({ id: f.id, label: f.label, type: f.type, value: r.answers[f.id] ?? null })),
      files: r.files.map((f) => ({ field: f.fieldId, name: f.name, type: f.type, size: f.size })),
    },
  };
}

export const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** The answers as an email: a row per question. */
function answersHtml(form: Form, r: Response): string {
  const rows = form.schema.fields
    .filter((f) => !NO_ANSWER.includes(f.type) && r.answers[f.id] !== undefined)
    .map((f) => `<tr><td style="padding:8px 12px 8px 0;color:#71717a;vertical-align:top;white-space:nowrap">${esc(f.label || f.id)}</td><td style="padding:8px 0;white-space:pre-wrap">${esc(answerText(r.answers[f.id]))}</td></tr>`)
    .join("");
  return `<div style="font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b;max-width:600px"><h2 style="font-size:18px;margin:0 0 12px">${esc(form.title)}</h2><table style="border-collapse:collapse">${rows}</table></div>`;
}

export class Notifier {
  readonly #db: DatabaseSync;
  readonly #forms: Forms;
  readonly #responses: Responses;
  readonly #secrets: Secrets;
  readonly #fetch: typeof fetch;
  #running = false;

  constructor(o: { db: DatabaseSync; forms: Forms; responses: Responses; secrets: Secrets; fetch?: typeof fetch }) {
    this.#db = o.db;
    this.#forms = o.forms;
    this.#responses = o.responses;
    this.#secrets = o.secrets;
    this.#fetch = o.fetch ?? fetch;
  }

  /** How emails go out, if the panel connected Email; the key stays hidden. */
  emailConfig(): (EmailConfig & { keyHint: string }) | null {
    const v = getSetting(this.#db, "email");
    if (!v) return null;
    const c = JSON.parse(v) as EmailConfig & { key: string; keyHint: string };
    return { url: c.url, from: c.from, brand: c.brand, keyHint: c.keyHint };
  }

  setEmail(input: unknown): void {
    if (input === null) return setSetting(this.#db, "email", "");
    const c = (input ?? {}) as Record<string, unknown>;
    const url = String(c.url ?? "").replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s/]+$/.test(url)) throw new InputError("url", "must be Email's address, like https://email.example.com");
    const key = String(c.key ?? "");
    if (!/^em_[\w-]{20,}$/.test(key)) throw new InputError("key", "must be an Email API key (em_…)");
    const from = String(c.from ?? "").trim();
    if (!/^([^<>]*<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}>?$/.test(from)) throw new InputError("from", "must be an address on one of the brand's verified domains");
    setSetting(this.#db, "email", JSON.stringify({ url, from, brand: String(c.brand ?? ""), key: this.#secrets.seal(key), keyHint: key.slice(0, 9) }));
  }

  /** The deliveries a new response needs. */
  queue(form: Form, responseId: number, now = Date.now()): void {
    const add = (kind: string) => this.#db.prepare("INSERT INTO deliveries (response_id, kind, next_at, created_at) VALUES (?, ?, ?, ?)").run(responseId, kind, now, now);
    if (form.notify.webhook) add("webhook");
    if (form.notify.email && this.emailConfig()) add("email");
    if (form.notify.receiptField && this.emailConfig()) add("receipt");
  }

  async #email(to: string, subject: string, html: string, replyTo?: string): Promise<void> {
    const raw = getSetting(this.#db, "email");
    if (!raw) throw new Error("Email isn't connected any more");
    const c = JSON.parse(raw) as EmailConfig & { key: string };
    const res = await this.#fetch(`${c.url}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.#secrets.open(c.key)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: c.from, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Email answered ${res.status}: ${((await res.json().catch(() => ({}))) as { message?: string }).message ?? ""}`);
  }

  async #deliver(d: { id: number; response_id: number; kind: string; attempts: number }): Promise<void> {
    const formId = (this.#db.prepare("SELECT form_id FROM responses WHERE id = ?").get(d.response_id) as { form_id: number } | undefined)?.form_id;
    try {
      if (formId === undefined) throw new Error("the response was deleted");
      const form = this.#forms.get(formId);
      const r = this.#responses.get(formId, d.response_id);
      if (d.kind === "webhook") {
        const body = JSON.stringify(payload(form, r));
        const res = await this.#fetch(form.notify.webhook, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Self-Host-Layer-Forms", "X-Forms-Signature": sign(form.notify.webhookSecret, body) }, body, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`the webhook answered ${res.status}`);
      } else if (d.kind === "email") {
        const replyTo = form.notify.receiptField ? answerText(r.answers[form.notify.receiptField]) : "";
        await this.#email(form.notify.email, `New response to ${form.title}`, answersHtml(form, r), replyTo || undefined);
      } else {
        const to = answerText(r.answers[form.notify.receiptField]);
        if (!to) return void this.#db.prepare("UPDATE deliveries SET status = 'done', error = 'no address in the answers' WHERE id = ?").run(d.id);
        await this.#email(to, `Your answers to ${form.title}`, answersHtml(form, r));
      }
      this.#db.prepare("UPDATE deliveries SET status = 'done', attempts = attempts + 1, error = NULL WHERE id = ?").run(d.id);
    } catch (err) {
      const attempts = d.attempts + 1;
      const failed = attempts > RETRY.length;
      this.#db.prepare("UPDATE deliveries SET status = ?, attempts = ?, next_at = ?, error = ? WHERE id = ?").run(failed ? "failed" : "pending", attempts, Date.now() + (RETRY[attempts - 1] ?? 0), (err as Error).message.slice(0, 500), d.id);
    }
  }

  /** Sends what's due. */
  async tick(now = Date.now()): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    try {
      const due = this.#db.prepare("SELECT id, response_id, kind, attempts FROM deliveries WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT 50").all(now) as { id: number; response_id: number; kind: string; attempts: number }[];
      for (const d of due) await this.#deliver(d);
      return due.length;
    } finally {
      this.#running = false;
    }
  }

  /** A sample to the form's webhook now, for its settings page; says what it answered. */
  async testWebhook(form: Form): Promise<{ status: number; error?: string }> {
    if (!form.notify.webhook) throw new InputError("webhook", "the form has no webhook");
    const sample: Response = { id: 0, formId: form.id, answers: Object.fromEntries(form.schema.fields.filter((f) => !NO_ANSWER.includes(f.type)).map((f) => [f.id, f.type === "number" ? 42 : f.options[0] ?? "A sample answer"])), meta: { duration: 30_000, country: null, device: null, browser: null, referrer: null }, files: [], createdAt: Date.now() };
    const body = JSON.stringify({ ...payload(form, sample), test: true });
    try {
      const res = await this.#fetch(form.notify.webhook, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Self-Host-Layer-Forms", "X-Forms-Signature": sign(form.notify.webhookSecret, body) }, body, signal: AbortSignal.timeout(15_000) });
      return res.ok ? { status: res.status } : { status: res.status, error: `it answered ${res.status}` };
    } catch (err) {
      return { status: 0, error: (err as Error).message };
    }
  }

  /** The last deliveries of a form, for its settings page. */
  recent(formId: number): { kind: string; status: string; attempts: number; error: string | null; createdAt: number }[] {
    return this.#db.prepare("SELECT d.kind, d.status, d.attempts, d.error, d.created_at createdAt FROM deliveries d JOIN responses r ON r.id = d.response_id WHERE r.form_id = ? ORDER BY d.id DESC LIMIT 20").all(formId) as never[];
  }
}

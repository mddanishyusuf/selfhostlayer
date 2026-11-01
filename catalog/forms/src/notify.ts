// Telling people about a response, after it's kept (never holding it up):
//   webhook  the response as JSON to the form's URL, signed with its secret
//            (X-Forms-Signature: sha256=<hex HMAC of the body>);
//   email    the owner's address, and a copy to the respondent, sent through
//            the Email integration's API (Forms keeps no SMTP of its own: the
//            panel gives it Email's address, a key and a From).
// Each is tried again after 1 minute, 10 minutes and an hour.
//
// A copy goes to whatever address someone typed, so it never repeats what was
// typed (anyone could send words of their own in the form's name that way):
// only answers the form's own words make up, one copy an address a day, and
// at most RECEIPTS_A_DAY a day from a form.
import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { InputError } from "../../lib/http.ts";
import type { Secrets } from "../../lib/secrets.ts";
import { getSetting, setSetting } from "./db.ts";
import type { Form, Forms } from "./forms.ts";
import type { Response, Responses } from "./responses.ts";
import { isEmail } from "./answers.ts";
import { answerText, NO_ANSWER, type FieldType } from "./schema.ts";

export interface EmailConfig {
  /** Email's public address, like https://email.example.com. */
  url: string;
  from: string;
  brand: string;
}

const RETRY = [60_000, 10 * 60_000, 60 * 60_000];
const DAY = 86_400_000;
/** Answers typed in, links and file names: never in a copy to the respondent. */
const TYPED: FieldType[] = ["short_text", "long_text", "email", "url", "phone", "hidden", "file"];
const RECEIPTS_A_DAY = 200;
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

/** The answers as an email: a row per question. A copy to the respondent has the ones the form's words make up only. */
function answersHtml(form: Form, r: Response, receipt = false): string {
  const answered = form.schema.fields.filter((f) => !NO_ANSWER.includes(f.type) && r.answers[f.id] !== undefined);
  const rows = answered
    .filter((f) => !receipt || !TYPED.includes(f.type))
    .map((f) => `<tr><td style="padding:8px 12px 8px 0;color:#71717a;vertical-align:top;white-space:nowrap">${esc(f.label || f.id)}</td><td style="padding:8px 0;white-space:pre-wrap">${esc(answerText(r.answers[f.id]))}</td></tr>`)
    .join("");
  const note = receipt ? `<p style="margin:0 0 12px">Thanks: your answers came in.${answered.some((f) => TYPED.includes(f.type)) ? " Answers you typed aren't repeated in this email." : ""}</p>` : "";
  return `<div style="font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b;max-width:600px"><h2 style="font-size:18px;margin:0 0 12px">${esc(form.title)}</h2>${note}${rows ? `<table style="border-collapse:collapse">${rows}</table>` : ""}</div>`;
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
        const res = await this.#fetch(form.notify.webhook, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Self-Host-Layer-Forms", "X-Forms-Signature": sign(form.notify.webhookSecret, body) }, body, redirect: "manual", signal: AbortSignal.timeout(15_000) });
        // A redirect isn't followed (it could point anywhere, this server included): it's a failure.
        if (!res.ok) throw new Error(`the webhook answered ${res.status}${res.status >= 300 && res.status < 400 ? " (a redirect: give the address it points to)" : ""}`);
      } else if (d.kind === "email") {
        // Replies go to whoever answered: the address their copy goes to, or else the form's first Email answer.
        const asked = form.notify.receiptField || form.schema.fields.find((f) => f.type === "email" && r.answers[f.id])?.id;
        const replyTo = asked ? answerText(r.answers[asked]) : "";
        await this.#email(form.notify.email, `New response to ${form.title}`, answersHtml(form, r), replyTo || undefined);
      } else {
        const to = answerText(r.answers[form.notify.receiptField]).trim().toLowerCase();
        const skip = (why: string) => void this.#db.prepare("UPDATE deliveries SET status = 'done', error = ? WHERE id = ?").run(why, d.id);
        if (!to) return skip("no address in the answers");
        if (!isEmail(to)) return skip("the answer isn't an email address");
        const sent = this.#db
          .prepare("SELECT count(*) n, count(CASE WHEN json_extract(r.answers, ?) = ? THEN 1 END) mine FROM deliveries d JOIN responses r ON r.id = d.response_id WHERE d.kind = 'receipt' AND d.status = 'done' AND d.error IS NULL AND r.form_id = ? AND d.created_at > ?")
          .get(`$."${form.notify.receiptField}"`, to, formId, Date.now() - DAY) as { n: number; mine: number };
        if (sent.mine > 0) return skip("a copy went to this address in the last day");
        if (sent.n >= RECEIPTS_A_DAY) return skip(`${RECEIPTS_A_DAY} copies went out today, the most a day`);
        await this.#email(to, `Your answers to ${form.title}`, answersHtml(form, r, true));
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
      const res = await this.#fetch(form.notify.webhook, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Self-Host-Layer-Forms", "X-Forms-Signature": sign(form.notify.webhookSecret, body) }, body, redirect: "manual", signal: AbortSignal.timeout(15_000) });
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

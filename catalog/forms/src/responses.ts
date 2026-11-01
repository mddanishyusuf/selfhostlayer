// Responses: the answers as kept (JSON by field id), what came with them (how
// long it took, the country, the device, the referring site), and their files
// on disk, data/uploads/<form>/<response>/<file id>, read back only through the
// admin API. Also the CSV export and the insights.
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { csvCell } from "../../lib/csv.ts";
import { InputError } from "../../lib/http.ts";
import type { Upload } from "./answers.ts";
import type { Form } from "./forms.ts";
import { answerText, NO_ANSWER } from "./schema.ts";

export interface Meta {
  /** Milliseconds from the page's load to the answers. */
  duration: number | null;
  country: string | null;
  device: string | null;
  browser: string | null;
  referrer: string | null;
}

export interface FileInfo {
  id: string;
  fieldId: string;
  name: string;
  type: string;
  size: number;
}

export interface Response {
  id: number;
  formId: number;
  answers: Record<string, unknown>;
  meta: Meta;
  files: FileInfo[];
  createdAt: number;
}

export interface FieldSummary {
  id: string;
  label: string;
  type: string;
  answered: number;
  /** Choices, ratings, scales and yes/no: how often each answer was given. */
  counts?: { value: string; count: number }[];
  average?: number | null;
  /** Scales from 0 to 10: promoters (9, 10) minus detractors (0 to 6), in percent. */
  nps?: number | null;
  /** Text: the latest answers. */
  latest?: string[];
}

export interface Insights {
  views: number;
  starts: number;
  responses: number;
  /** Responses of starts (0 to 1); null before anyone started. */
  completion: number | null;
  /** Median milliseconds to fill it in. */
  medianDuration: number | null;
  series: { at: number; responses: number }[];
  fields: FieldSummary[];
}

const DAY = 86_400_000;

export class Responses {
  readonly #db: DatabaseSync;
  readonly #dir: string;

  constructor(db: DatabaseSync, dataDir: string) {
    this.#db = db;
    this.#dir = join(dataDir, "uploads");
  }

  #files(responseId: number): FileInfo[] {
    return this.#db.prepare("SELECT id, field_id fieldId, name, type, size FROM files WHERE response_id = ? ORDER BY created_at").all(responseId) as unknown as FileInfo[];
  }

  #from(r: { id: number; form_id: number; answers: string; meta: string; created_at: number }): Response {
    return { id: r.id, formId: r.form_id, answers: JSON.parse(r.answers), meta: JSON.parse(r.meta), files: this.#files(r.id), createdAt: r.created_at };
  }

  /** Where files wait while they come in, beside their final place (so they're moved, never copied). */
  get staging(): string {
    return join(this.#dir, ".incoming");
  }

  /** Keeps a response and moves its files in from where they came (`path`); returns its id. */
  store(form: Form, answers: Record<string, unknown>, uploads: (Upload & { path: string })[], meta: Meta, now = Date.now()): number {
    const db = this.#db;
    db.exec("BEGIN");
    let id = 0;
    try {
      id = Number(db.prepare("INSERT INTO responses (form_id, answers, meta, created_at) VALUES (?, ?, ?, ?)").run(form.id, JSON.stringify(answers), JSON.stringify(meta), now).lastInsertRowid);
      if (uploads.length) {
        const dir = join(this.#dir, String(form.id), String(id));
        mkdirSync(dir, { recursive: true });
        for (const u of uploads) {
          const fileId = randomBytes(12).toString("hex");
          db.prepare("INSERT INTO files (id, response_id, form_id, field_id, name, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(fileId, id, form.id, u.fieldId, u.name, u.type, u.size, now);
          renameSync(u.path, join(dir, fileId));
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      if (id) rmSync(join(this.#dir, String(form.id), String(id)), { recursive: true, force: true });
      throw err;
    }
    return id;
  }

  list(formId: number, o: { q?: string; page?: number } = {}): { responses: Response[]; total: number; page: number; pageSize: number } {
    const parts = ["form_id = ?"];
    const args: SQLInputValue[] = [formId];
    if (o.q?.trim()) {
      parts.push("answers LIKE ? ESCAPE '\\'");
      args.push(`%${o.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const where = parts.join(" AND ");
    const total = (this.#db.prepare(`SELECT count(*) n FROM responses WHERE ${where}`).get(...args) as { n: number }).n;
    const pageSize = 50;
    const page = Math.max(1, Math.min(o.page ?? 1, Math.ceil(total / pageSize) || 1));
    const rows = this.#db.prepare(`SELECT * FROM responses WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`).all(...args) as never[];
    return { responses: rows.map((r) => this.#from(r)), total, page, pageSize };
  }

  get(formId: number, id: number): Response {
    const r = this.#db.prepare("SELECT * FROM responses WHERE id = ? AND form_id = ?").get(id, formId) as never;
    if (!r) throw new InputError("response", "no such response", 404);
    return this.#from(r);
  }

  remove(formId: number, id: number): void {
    this.get(formId, id);
    this.#db.prepare("DELETE FROM files WHERE response_id = ?").run(id);
    this.#db.prepare("DELETE FROM deliveries WHERE response_id = ?").run(id);
    this.#db.prepare("DELETE FROM responses WHERE id = ?").run(id);
    rmSync(join(this.#dir, String(formId), String(id)), { recursive: true, force: true });
  }

  /** Every response of a form, and their files. */
  removeAll(formId: number): number {
    const n = Number(this.#db.prepare("DELETE FROM responses WHERE form_id = ?").run(formId).changes);
    this.#db.prepare("DELETE FROM files WHERE form_id = ?").run(formId);
    this.#db.prepare("DELETE FROM deliveries WHERE response_id NOT IN (SELECT id FROM responses)").run();
    rmSync(join(this.#dir, String(formId)), { recursive: true, force: true });
    return n;
  }

  /** A file of a form, for the admin API to send. */
  file(formId: number, fileId: string): FileInfo & { path: string; responseId: number } {
    if (!/^[0-9a-f]{24}$/.test(fileId)) throw new InputError("file", "no such file", 404);
    const r = this.#db.prepare("SELECT id, response_id responseId, field_id fieldId, name, type, size FROM files WHERE id = ? AND form_id = ?").get(fileId, formId) as (FileInfo & { responseId: number }) | undefined;
    if (!r) throw new InputError("file", "no such file", 404);
    return { ...r, path: join(this.#dir, String(formId), String(r.responseId), r.id) };
  }

  /** Every response as CSV: a column per question (by its label), then when, how long, where from. */
  csv(form: Form): string {
    const fields = form.schema.fields.filter((f) => !NO_ANSWER.includes(f.type));
    const head = ["submitted_at", ...fields.map((f) => f.label || f.id), "duration_seconds", "country", "device", "referrer"];
    const rows = (this.#db.prepare("SELECT * FROM responses WHERE form_id = ? ORDER BY created_at").all(form.id) as never[]).map((r) => this.#from(r));
    const lines = rows.map((r) => [new Date(r.createdAt).toISOString(), ...fields.map((f) => answerText(r.answers[f.id])), r.meta.duration === null ? "" : String(Math.round(r.meta.duration / 1000)), r.meta.country ?? "", r.meta.device ?? "", r.meta.referrer ?? ""].map(csvCell).join(","));
    return `${[head.map(csvCell).join(","), ...lines].join("\n")}\n`;
  }

  insights(form: Form, days = 30, now = Date.now()): Insights {
    const from = Math.floor(now / DAY) * DAY - (days - 1) * DAY;
    const series = new Map<number, number>();
    for (let at = from; at <= now; at += DAY) series.set(at, 0);
    for (const r of this.#db.prepare(`SELECT (created_at / ${DAY}) * ${DAY} d, count(*) n FROM responses WHERE form_id = ? AND created_at >= ? GROUP BY d`).all(form.id, from) as { d: number; n: number }[]) if (series.has(r.d)) series.set(r.d, r.n);
    const all = (this.#db.prepare("SELECT answers, meta FROM responses WHERE form_id = ?").all(form.id) as { answers: string; meta: string }[]).map((r) => ({ answers: JSON.parse(r.answers) as Record<string, unknown>, meta: JSON.parse(r.meta) as Meta }));
    const durations = all.map((r) => r.meta.duration).filter((d): d is number => typeof d === "number").sort((a, b) => a - b);
    const fields: FieldSummary[] = form.schema.fields
      .filter((f) => !NO_ANSWER.includes(f.type))
      .map((f) => {
        const given = all.map((r) => r.answers[f.id]).filter((a) => a !== undefined && a !== null && a !== "" && !(Array.isArray(a) && !a.length));
        const s: FieldSummary = { id: f.id, label: f.label || f.id, type: f.type, answered: given.length };
        if (["choice", "dropdown", "multi", "yes_no", "rating", "scale"].includes(f.type)) {
          const counts = new Map<string, number>();
          const order = f.type === "yes_no" ? ["yes", "no"] : f.type === "rating" ? Array.from({ length: f.max ?? 5 }, (_, i) => String(i + 1)) : f.type === "scale" ? Array.from({ length: (f.max ?? 10) - (f.min ?? 0) + 1 }, (_, i) => String((f.min ?? 0) + i)) : f.options;
          for (const o of order) counts.set(o, 0);
          for (const a of given) for (const v of Array.isArray(a) ? a : [a]) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
          s.counts = [...counts].map(([value, count]) => ({ value, count }));
        }
        if (["rating", "scale", "number"].includes(f.type)) {
          const nums = given.map(Number).filter(Number.isFinite);
          s.average = nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null;
          if (f.type === "scale" && (f.min ?? 0) === 0 && (f.max ?? 10) === 10 && nums.length) s.nps = Math.round(((nums.filter((n) => n >= 9).length - nums.filter((n) => n <= 6).length) / nums.length) * 100);
        }
        if (["short_text", "long_text", "email", "url", "phone", "date", "hidden", "file"].includes(f.type)) s.latest = given.slice(-5).reverse().map((a) => answerText(a).slice(0, 300));
        return s;
      });
    return {
      views: form.views,
      starts: form.starts,
      responses: all.length,
      completion: form.starts ? Math.min(1, all.length / form.starts) : null,
      medianDuration: durations.length ? durations[Math.floor(durations.length / 2)]! : null,
      series: [...series].map(([at, responses]) => ({ at, responses })),
      fields,
    };
  }
}

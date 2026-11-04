// Imports as background jobs: a CSV streamed to data/imports/<id>.csv, its
// columns mapped by the owner (email, name or first and last name, fields, or
// skipped), then read back 1,000 rows at a time: optionally a Shield pass first
// that stops for review, then the import itself. Progress is saved after every
// batch, so a job outlives the page that started it and carries on after a
// restart; a short pause between batches keeps sending and the API responsive
// on a job of millions.
import { closeSync, createReadStream, createWriteStream, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DatabaseSync } from "node:sqlite";
import { csvValue, CsvReader } from "../../lib/csv.ts";
import { InputError } from "../../lib/http.ts";
import type { Contacts, Verdicts } from "./contacts.ts";
import { isEmail } from "./mime.ts";
import type { Shield, VerdictSummary } from "./shield.ts";

export const MAX_IMPORT_BYTES = 1024 ** 3;
const BATCH = 1000;
const PAUSE_MS = 20;
const FIELD = /^[a-z][a-z0-9_]{0,39}$/;

export type ImportStatus = "mapping" | "checking" | "review" | "importing" | "done" | "failed" | "cancelled";

/** Which column is which, by index (headers can repeat). */
export interface Mapping {
  email: number;
  name: number | null;
  first: number | null;
  last: number | null;
  fields: { column: number; key: string }[];
}

export interface ImportOptions {
  lists: number[];
  /** Shield's address checks on every row. */
  shield: boolean;
  /** Check everything first and wait for Continue, with the counts. */
  review: boolean;
  /** "flagged": addresses Shield refuses come in flagged instead. */
  include: "clean" | "flagged";
}

export interface ImportCounts {
  created: number;
  updated: number;
  refused: number;
  flagged: number;
  skipped: number;
}

export interface ImportJob {
  id: number;
  brandId: number;
  status: ImportStatus;
  filename: string;
  bytes: number;
  headers: string[];
  sample: string[][];
  guess: Mapping;
  mapping: Mapping | null;
  options: ImportOptions | null;
  /** Data rows, once a pass has read them all. */
  rows: number | null;
  checked: number;
  processed: number;
  counts: ImportCounts;
  shield: Omit<VerdictSummary, "total"> & { total: number };
  skipped: { line: number; reason: string }[];
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

interface Row {
  id: number;
  brand_id: number;
  status: ImportStatus;
  filename: string;
  bytes: number;
  headers: string;
  mapping: string | null;
  options: string | null;
  rows: number | null;
  checked: number;
  processed: number;
  counts: string;
  shield: string;
  skipped: string;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

const EMPTY_COUNTS: ImportCounts = { created: 0, updated: 0, refused: 0, flagged: 0, skipped: 0 };
const EMPTY_SHIELD = { total: 0, ok: 0, flag: 0, refuse: 0, byCheck: {}, examples: {} };

const fieldKey = (header: string) =>
  header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "f_$1")
    .slice(0, 40);

/** A first guess at the mapping, from the headers' names: the owner changes what's wrong. */
export function guessMapping(headers: string[]): Mapping {
  const names = headers.map((h) => h.trim().toLowerCase());
  const at = (aliases: string[]) => {
    const i = names.findIndex((n) => aliases.includes(n));
    return i < 0 ? null : i;
  };
  const email = at(["email", "e-mail", "email address", "email_address", "mail"]) ?? names.findIndex((n) => n.includes("mail"));
  const name = at(["name", "full name", "full_name", "fullname"]);
  const first = name === null ? at(["first name", "first_name", "firstname", "given name"]) : null;
  const last = name === null ? at(["last name", "last_name", "lastname", "surname", "family name"]) : null;
  const taken = new Set([email, name, first, last, at(["status", "lists", "created_at"])]);
  const fields = headers
    .map((h, column) => ({ column, key: fieldKey(h) }))
    .filter((f) => !taken.has(f.column) && FIELD.test(f.key))
    .slice(0, 30);
  return { email, name, first, last, fields };
}

function checkMapping(value: unknown, columns: number): Mapping {
  const m = (value ?? {}) as Record<string, unknown>;
  const col = (v: unknown, what: string, required = false): number | null => {
    if ((v === null || v === undefined || v === "") && !required) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n >= columns) throw new InputError("mapping", `${what}: pick one of the file's columns`);
    return n;
  };
  const email = col(m.email, "the email column", true)!;
  const fields = Array.isArray(m.fields) ? m.fields : [];
  if (fields.length > 30) throw new InputError("mapping", "at most 30 columns as fields");
  const keys = new Set<string>();
  const out: Mapping = {
    email,
    name: col(m.name, "the name column"),
    first: col(m.first, "the first name column"),
    last: col(m.last, "the last name column"),
    fields: fields.map((f: { column?: unknown; key?: unknown }) => {
      const key = typeof f?.key === "string" ? f.key.trim() : "";
      if (!FIELD.test(key)) throw new InputError("mapping", `${key.slice(0, 40) || "a field"}: names are lowercase letters, digits and _, starting with a letter`);
      if (keys.has(key)) throw new InputError("mapping", `two columns go to the field ${key}`);
      keys.add(key);
      return { column: col(f?.column, `the field ${key}`, true)!, key };
    }),
  };
  return out;
}

export interface ImportsOptions {
  db: DatabaseSync;
  dir: string;
  contacts: Contacts;
  shield: Shield;
  /** false in tests: jobs run when the test says (run()). */
  background?: boolean;
}

export class Imports {
  readonly #db: DatabaseSync;
  readonly #dir: string;
  readonly #contacts: Contacts;
  readonly #shield: Shield;
  readonly #background: boolean;
  readonly #running = new Map<number, Promise<void>>();

  constructor(o: ImportsOptions) {
    this.#db = o.db;
    this.#dir = o.dir;
    this.#contacts = o.contacts;
    this.#shield = o.shield;
    this.#background = o.background !== false;
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
  }

  #file = (id: number) => join(this.#dir, `${id}.csv`);

  #from(r: Row): ImportJob {
    const head = JSON.parse(r.headers) as { headers: string[]; sample: string[][]; guess: Mapping };
    return {
      id: r.id,
      brandId: r.brand_id,
      status: r.status,
      filename: r.filename,
      bytes: r.bytes,
      headers: head.headers ?? [],
      sample: head.sample ?? [],
      guess: head.guess,
      mapping: r.mapping ? (JSON.parse(r.mapping) as Mapping) : null,
      options: r.options ? (JSON.parse(r.options) as ImportOptions) : null,
      rows: r.rows,
      checked: r.checked,
      processed: r.processed,
      counts: { ...EMPTY_COUNTS, ...(JSON.parse(r.counts) as Partial<ImportCounts>) },
      shield: { ...EMPTY_SHIELD, ...(JSON.parse(r.shield) as object) },
      skipped: JSON.parse(r.skipped) as { line: number; reason: string }[],
      error: r.error,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    };
  }

  get(brandId: number, id: number): ImportJob {
    const r = this.#db.prepare("SELECT * FROM imports WHERE id = ? AND brand_id = ?").get(id, brandId) as Row | undefined;
    if (!r) throw new InputError("import", "no such import", 404);
    return this.#from(r);
  }

  /** The brand's imports of the last week, newest first: running ones, and what finished. */
  list(brandId: number): ImportJob[] {
    return (this.#db.prepare("SELECT * FROM imports WHERE brand_id = ? AND status != 'mapping' AND created_at >= ? ORDER BY id DESC LIMIT 20").all(brandId, Date.now() - 7 * 86_400_000) as unknown as Row[]).map((r) => this.#from(r));
  }

  /** The upload: streamed to disk (up to 1 GB), then its header row and a few rows read back for the mapping. */
  async create(brandId: number, body: IncomingMessage, filename: string): Promise<ImportJob> {
    const name = filename.replace(/[^\w .()-]/g, "_").slice(0, 120) || "contacts.csv";
    const id = Number(this.#db.prepare("INSERT INTO imports (brand_id, status, filename, created_at) VALUES (?, 'mapping', ?, ?)").run(brandId, name, Date.now()).lastInsertRowid);
    const file = this.#file(id);
    let bytes = 0;
    try {
      await pipeline(
        body,
        new Transform({
          transform(chunk: Buffer, _enc, done) {
            bytes += chunk.length;
            done(bytes > MAX_IMPORT_BYTES ? new InputError("csv", "the file is over 1 GB: split it") : null, chunk);
          },
        }),
        createWriteStream(file, { mode: 0o600 }),
      );
      if (!bytes) throw new InputError("csv", "the file is empty");
      const { headers, sample } = this.#head(file);
      if (!headers.length || headers.every((h) => !h.trim())) throw new InputError("csv", "the first row should name the columns");
      this.#db.prepare("UPDATE imports SET bytes = ?, headers = ? WHERE id = ?").run(bytes, JSON.stringify({ headers, sample, guess: guessMapping(headers) }), id);
    } catch (err) {
      rmSync(file, { force: true });
      this.#db.prepare("DELETE FROM imports WHERE id = ?").run(id);
      throw err;
    }
    return this.get(brandId, id);
  }

  /** The header row and up to five rows after it, from the first 256 KB. */
  #head(file: string): { headers: string[]; sample: string[][] } {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const r = new CsvReader();
      const rows = r.push(buf.subarray(0, n).toString("utf8"));
      if (n < buf.length) rows.push(...r.end());
      const [headers = [], ...rest] = rows.map((row) => row.map(csvValue));
      return { headers: headers.map((h) => h.trim()), sample: rest.slice(0, 5) };
    } finally {
      closeSync(fd);
    }
  }

  /** The owner's mapping and choices: the job starts, with Shield's pass first when they asked to review. */
  start(brandId: number, id: number, input: Record<string, unknown>): ImportJob {
    const job = this.get(brandId, id);
    if (job.status !== "mapping") throw new InputError("import", "this import has started already", 409);
    const mapping = checkMapping(input.mapping, job.headers.length);
    const options: ImportOptions = {
      lists: this.#contacts.resolveLists(brandId, input.lists),
      shield: input.shield !== false,
      review: input.shield !== false && input.review === true,
      include: input.include === "flagged" ? "flagged" : "clean",
    };
    this.#db.prepare("UPDATE imports SET status = ?, mapping = ?, options = ?, started_at = ? WHERE id = ?").run(options.review ? "checking" : "importing", JSON.stringify(mapping), JSON.stringify(options), Date.now(), id);
    this.#kick(id);
    return this.get(brandId, id);
  }

  /** After the review: import, leaving refused addresses out or bringing them in flagged. */
  continue(brandId: number, id: number, input: Record<string, unknown>): ImportJob {
    const job = this.get(brandId, id);
    if (job.status !== "review") throw new InputError("import", "this import isn't waiting for review", 409);
    const options = { ...job.options!, include: input.include === "flagged" ? ("flagged" as const) : ("clean" as const) };
    this.#db.prepare("UPDATE imports SET status = 'importing', options = ? WHERE id = ?").run(JSON.stringify(options), id);
    this.#kick(id);
    return this.get(brandId, id);
  }

  /** Stops it between batches; what's imported stays. */
  cancel(brandId: number, id: number): ImportJob {
    const job = this.get(brandId, id);
    if (["done", "failed", "cancelled"].includes(job.status)) return job;
    this.#db.prepare("UPDATE imports SET status = 'cancelled', finished_at = ? WHERE id = ?").run(Date.now(), id);
    if (!this.#running.has(id)) rmSync(this.#file(id), { force: true });
    return this.get(brandId, id);
  }

  /** At start: carries on with jobs a restart cut short, and forgets uploads never mapped within a day. */
  resume(): void {
    for (const r of this.#db.prepare("SELECT id FROM imports WHERE status = 'mapping' AND created_at < ?").all(Date.now() - 86_400_000) as { id: number }[]) {
      rmSync(this.#file(r.id), { force: true });
      this.#db.prepare("DELETE FROM imports WHERE id = ?").run(r.id);
    }
    for (const r of this.#db.prepare("SELECT id FROM imports WHERE status IN ('checking', 'importing')").all() as { id: number }[]) this.#kick(r.id);
  }

  #kick(id: number): void {
    if (this.#background) void this.run(id);
  }

  /** Runs a job to its end, or to its review (tests call this; the server does through #kick). */
  run(id: number): Promise<void> {
    const running = this.#running.get(id);
    if (running) return running;
    const p = this.#runLoop(id).finally(() => this.#running.delete(id));
    this.#running.set(id, p);
    return p;
  }

  #status = (id: number) => (this.#db.prepare("SELECT status FROM imports WHERE id = ?").get(id) as { status: ImportStatus } | undefined)?.status;

  async #runLoop(id: number): Promise<void> {
    try {
      for (;;) {
        const status = this.#status(id);
        const r = this.#db.prepare("SELECT * FROM imports WHERE id = ?").get(id) as Row | undefined;
        if (!r) return;
        const job = this.#from(r);
        if (status === "checking") await this.#check(job);
        else if (status === "importing") await this.#import(job);
        else break;
        const after = this.#status(id);
        if (after === status) break;
      }
    } catch (err) {
      this.#db.prepare("UPDATE imports SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run((err as Error).message.slice(0, 500), Date.now(), id);
      console.error(`import ${id} failed: ${(err as Error).message}`);
    } finally {
      const status = this.#status(id);
      if (status === "done" || status === "failed" || status === "cancelled") rmSync(this.#file(id), { force: true });
    }
  }

  /** The file's data rows, 1,000 at a time, with the line each batch starts on. */
  async *#batches(id: number): AsyncGenerator<{ rows: string[][]; first: number }> {
    const reader = new CsvReader();
    let header = true;
    let batch: string[][] = [];
    let index = 0;
    const take = function* (rows: string[][]) {
      for (const row of rows) {
        if (header) {
          header = false;
          continue;
        }
        batch.push(row.map(csvValue));
        if (batch.length >= BATCH) {
          yield { rows: batch, first: index };
          index += batch.length;
          batch = [];
        }
      }
    };
    for await (const piece of createReadStream(this.#file(id), { encoding: "utf8", highWaterMark: 256 * 1024 })) yield* take(reader.push(piece as string));
    yield* take(reader.end());
    if (batch.length) yield { rows: batch, first: index };
  }

  /** A row as a contact, by the mapping; null without an address. */
  #contact(row: string[], m: Mapping): { email: string; name: string; fields: Record<string, string> } | { bad: string } {
    const email = (row[m.email] ?? "").trim();
    if (!isEmail(email)) return { bad: email ? `${email.slice(0, 80)} isn't an email address` : "no email" };
    const cell = (i: number | null) => (i === null ? "" : (row[i] ?? "").trim());
    const name = m.name !== null ? cell(m.name) : [cell(m.first), cell(m.last)].filter(Boolean).join(" ");
    const fields = Object.fromEntries(m.fields.map((f) => [f.key, cell(f.column).slice(0, 500)]).filter(([, v]) => v));
    return { email: email.toLowerCase(), name: name.replace(/[\r\n]+/g, " ").slice(0, 200), fields };
  }

  #merge(into: ImportJob["shield"], s: VerdictSummary): void {
    into.total += s.total;
    into.ok += s.ok;
    into.flag += s.flag;
    into.refuse += s.refuse;
    for (const [check, b] of Object.entries(s.byCheck)) {
      const t = (into.byCheck[check as keyof typeof into.byCheck] ??= { action: b!.action, count: 0 });
      t.count += b!.count;
      const ex = (into.examples[check as keyof typeof into.examples] ??= []);
      for (const e of s.examples[check as keyof typeof s.examples] ?? []) if (ex.length < 5) ex.push(e);
    }
  }

  /** Shield's pass for the review: counts by check, saved per batch; then it waits. */
  async #check(job: ImportJob): Promise<void> {
    const summary = job.shield;
    let seen = 0;
    for await (const { rows, first } of this.#batches(job.id)) {
      seen = first + rows.length;
      if (seen <= job.checked) continue;
      if (this.#status(job.id) !== "checking") return;
      const emails = rows.map((r) => this.#contact(r, job.mapping!)).flatMap((c) => ("email" in c ? [c.email] : []));
      this.#merge(summary, (await this.#shield.verdicts(job.brandId, emails)).summary);
      this.#db.prepare("UPDATE imports SET checked = ?, shield = ? WHERE id = ? AND status = 'checking'").run(seen, JSON.stringify(summary), job.id);
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
    this.#db.prepare("UPDATE imports SET status = 'review', rows = ?, checked = ? WHERE id = ? AND status = 'checking'").run(seen, seen, job.id);
  }

  /** The import, batch by batch: Shield's verdicts (unless off), then in like any import. */
  async #import(job: ImportJob): Promise<void> {
    const counts = job.counts;
    const skipped = job.skipped;
    const summary = job.shield;
    const o = job.options!;
    let seen = 0;
    for await (const { rows, first } of this.#batches(job.id)) {
      seen = first + rows.length;
      if (seen <= job.processed) continue;
      if (this.#status(job.id) !== "importing") return;
      const parsed = { rows: [] as { line: number; email: string; name: string; fields: Record<string, string> }[], skipped: [] as { line: number; reason: string }[] };
      rows.forEach((row, i) => {
        const c = this.#contact(row, job.mapping!);
        // Line numbers as a spreadsheet shows them: the header is line 1.
        if ("bad" in c) parsed.skipped.push({ line: first + i + 2, reason: c.bad });
        else parsed.rows.push({ line: first + i + 2, ...c });
      });
      let verdicts: Verdicts | undefined;
      if (o.shield) {
        const v = await this.#shield.verdicts(job.brandId, parsed.rows.map((r) => r.email));
        verdicts = v.verdicts;
        if (!o.review) this.#merge(summary, v.summary);
        if (o.include === "flagged") for (const x of verdicts.values()) if (x.outcome === "refuse") x.outcome = "flag";
        this.#shield.logBatch(job.brandId, verdicts, "import");
      }
      const r = this.#contacts.importRows(job.brandId, parsed, { lists: o.lists, verdicts, source: "import" });
      counts.created += r.created;
      counts.updated += r.updated;
      counts.refused += r.refused;
      counts.flagged += r.flagged;
      // Rows without an address, and rows the import couldn't take (r.skipped is cut at 200, so counted, not read).
      counts.skipped += parsed.skipped.length + Math.max(0, parsed.rows.length - r.created - r.updated - r.refused);
      for (const s of r.skipped) if (skipped.length < 200) skipped.push(s);
      this.#db.prepare("UPDATE imports SET processed = ?, counts = ?, skipped = ?, shield = ? WHERE id = ? AND status = 'importing'").run(seen, JSON.stringify(counts), JSON.stringify(skipped), JSON.stringify(summary), job.id);
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
    this.#db.prepare("UPDATE imports SET status = 'done', rows = ?, processed = ?, finished_at = ? WHERE id = ? AND status = 'importing'").run(seen, seen, Date.now(), job.id);
  }
}

// A response, checked against its form before it's kept: every shown field's
// answer in its own shape (an option of its choices, a number in its range, an
// email address…), required ones present, and the answers to fields the logic
// hid dropped. Files are announced first (field, name, type, size: up to 10 MB
// each, 25 MB in all), so they're checked before any of their bytes is read.
import { InputError } from "../../lib/http.ts";
import { NO_ANSWER, visible, type Field, type Schema } from "./schema.ts";

/** A file a response keeps: `index` is its place among the files that came. */
export interface Upload {
  fieldId: string;
  name: string;
  type: string;
  size: number;
  index: number;
}

export const MAX_FILE = 10 * 1024 * 1024;
export const MAX_FILES = 25 * 1024 * 1024;

/**
 * The most a response's answers can take as JSON, files aside: each answer at
 * its longest, every character escaped, with room for the rest.
 */
export function maxAnswersBytes(schema: Schema): number {
  let n = 16 * 1024;
  for (const f of schema.fields) {
    const chars =
      f.type === "short_text" || f.type === "long_text" || f.type === "phone" || f.type === "hidden" ? (f.maxLength ?? (f.type === "long_text" ? 10_000 : 1000))
      : f.type === "email" ? 254
      : f.type === "url" ? 2000
      : f.type === "file" ? 300
      : f.options.reduce((a, o) => a + o.length + 3, 0) + 64;
    n += 128 + chars * 6;
  }
  return n;
}
// As Email's own rule: an address its API takes as one recipient, nothing more.
const EMAIL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,62}$/;

export const isEmail = (s: string): boolean => s.length <= 254 && s.indexOf("@") <= 64 && EMAIL.test(s);

const missing = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);

/** Whether a file's name or type fits an <input accept> list (".pdf, image/*"). */
export function accepts(accept: string, name: string, type: string): boolean {
  if (!accept.trim()) return true;
  const ext = `.${name.split(".").pop()?.toLowerCase() ?? ""}`;
  return accept.split(",").some((a) => {
    const t = a.trim().toLowerCase();
    return t.startsWith(".") ? t === ext : t.endsWith("/*") ? type.toLowerCase().startsWith(t.slice(0, -1)) : t === type.toLowerCase();
  });
}

function one(f: Field, v: unknown): unknown {
  const bad = (why: string): never => {
    throw new InputError(f.id, `${f.label || f.id}: ${why}`);
  };
  switch (f.type) {
    case "short_text":
    case "long_text":
    case "phone":
    case "hidden": {
      if (typeof v !== "string") bad("must be text");
      const s = (v as string).trim();
      const max = f.maxLength ?? (f.type === "long_text" ? 10_000 : 1000);
      if (s.length > max) bad(`at most ${max} characters`);
      if (f.type === "phone" && s && !/^[+()\d\s.-]{4,30}$/.test(s)) bad("isn't a phone number");
      return s;
    }
    case "email": {
      const s = typeof v === "string" ? v.trim() : "";
      if (!isEmail(s)) bad("isn't an email address");
      return s.toLowerCase();
    }
    case "url": {
      const s = typeof v === "string" ? v.trim() : "";
      if (!/^https?:\/\/\S+$/i.test(s) || s.length > 2000) bad("isn't a link (https://…)");
      return s;
    }
    case "number": {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) bad("must be a number");
      if (f.min !== null && n < f.min) bad(`at least ${f.min}`);
      if (f.max !== null && n > f.max) bad(`at most ${f.max}`);
      return n;
    }
    case "choice":
    case "dropdown":
      if (typeof v !== "string" || !f.options.includes(v)) bad("isn't one of the choices");
      return v;
    case "multi": {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !f.options.includes(x))) bad("isn't among the choices");
      return f.options.filter((o) => (v as string[]).includes(o));
    }
    case "yes_no":
      if (v === true || v === "yes") return "yes";
      if (v === false || v === "no") return "no";
      return bad("must be yes or no");
    case "rating": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > (f.max ?? 5)) bad(`must be 1 to ${f.max ?? 5}`);
      return n;
    }
    case "scale": {
      const n = Number(v);
      const [lo, hi] = [f.min ?? 0, f.max ?? 10];
      if (!Number.isInteger(n) || n < lo || n > hi) bad(`must be ${lo} to ${hi}`);
      return n;
    }
    case "date": {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) bad("must be a date");
      return v;
    }
    default:
      return bad("can't be answered");
  }
}

/** The answers as kept, and the files to write. Throws an InputError naming the first wrong answer. */
export function checkAnswers(schema: Schema, input: { answers?: unknown; files?: unknown }): { answers: Record<string, unknown>; uploads: Upload[] } {
  const given = (input.answers ?? {}) as Record<string, unknown>;
  if (typeof given !== "object" || Array.isArray(given)) throw new InputError("answers", "must map fields to answers");
  // The files as announced: [{ field, name, type, size }], in the order their bytes follow.
  const announced = input.files ?? [];
  if (!Array.isArray(announced) || announced.length > 50) throw new InputError("files", "must list the files");
  const files = new Map<string, { name?: unknown; type?: unknown; size?: unknown; index: number }>();
  let coming = 0;
  announced.forEach((x: unknown, index) => {
    const file = (typeof x === "object" && x !== null ? x : {}) as { field?: unknown; name?: unknown; type?: unknown; size?: unknown };
    const field = schema.fields.find((f) => f.type === "file" && f.id === file.field);
    if (!field || files.has(field.id) || !Number.isInteger(file.size) || (file.size as number) < 0) throw new InputError("files", "a file couldn't be read");
    if ((file.size as number) > MAX_FILE) throw new InputError(field.id, `${field.label || field.id}: files are at most 10 MB`, 413);
    coming += file.size as number;
    files.set(field.id, { ...file, index });
  });
  if (coming > MAX_FILES) throw new InputError("files", "the files are over 25 MB in all", 413);
  const answers: Record<string, unknown> = {};
  const uploads: Upload[] = [];
  for (const f of schema.fields) {
    if (NO_ANSWER.includes(f.type)) continue;
    // Logic runs on what's been answered so far, in order.
    if (!visible(f, answers, schema.fields)) continue;
    if (f.type === "file") {
      const file = files.get(f.id);
      if (!file) {
        if (f.required) throw new InputError(f.id, `${f.label || f.id}: a file is required`);
        continue;
      }
      const name = typeof file.name === "string" ? file.name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 200) : "";
      const type = typeof file.type === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : "application/octet-stream";
      if (!name) throw new InputError(f.id, `${f.label || f.id}: the file couldn't be read`);
      if (!accepts(f.accept, name, type)) throw new InputError(f.id, `${f.label || f.id}: ${name} isn't a kind of file it takes (${f.accept})`);
      uploads.push({ fieldId: f.id, name, type, size: file.size as number, index: file.index });
      answers[f.id] = name;
      continue;
    }
    const v = given[f.id];
    if (missing(v)) {
      if (f.required) throw new InputError(f.id, `${f.label || f.id}: an answer is required`);
      continue;
    }
    answers[f.id] = one(f, v);
  }
  return { answers, uploads };
}

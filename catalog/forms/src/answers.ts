// A response, checked against its form before it's kept: every shown field's
// answer in its own shape (an option of its choices, a number in its range, an
// email address…), required ones present, and the answers to fields the logic
// hid dropped. Files come in base64: up to 10 MB each, 25 MB in all.
import { InputError } from "../../lib/http.ts";
import { NO_ANSWER, visible, type Field, type Schema } from "./schema.ts";

export interface Upload {
  fieldId: string;
  name: string;
  type: string;
  data: Buffer;
}

export const MAX_FILE = 10 * 1024 * 1024;
const MAX_FILES = 25 * 1024 * 1024;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

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
      if (!EMAIL.test(s) || s.length > 254) bad("isn't an email address");
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
  const files = (input.files ?? {}) as Record<string, { name?: unknown; type?: unknown; data?: unknown }>;
  const answers: Record<string, unknown> = {};
  const uploads: Upload[] = [];
  let bytes = 0;
  for (const f of schema.fields) {
    if (NO_ANSWER.includes(f.type)) continue;
    // Logic runs on what's been answered so far, in order.
    if (!visible(f, answers, schema.fields)) continue;
    if (f.type === "file") {
      const file = files[f.id];
      if (!file) {
        if (f.required) throw new InputError(f.id, `${f.label || f.id}: a file is required`);
        continue;
      }
      const name = typeof file.name === "string" ? file.name.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 200) : "";
      const type = typeof file.type === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : "application/octet-stream";
      if (!name || typeof file.data !== "string" || !/^[A-Za-z0-9+/=]*$/.test(file.data)) throw new InputError(f.id, `${f.label || f.id}: the file couldn't be read`);
      if (!accepts(f.accept, name, type)) throw new InputError(f.id, `${f.label || f.id}: ${name} isn't a kind of file it takes (${f.accept})`);
      const data = Buffer.from(file.data, "base64");
      if (data.length > MAX_FILE) throw new InputError(f.id, `${f.label || f.id}: files are at most 10 MB`);
      bytes += data.length;
      if (bytes > MAX_FILES) throw new InputError(f.id, "the files are over 25 MB in all");
      uploads.push({ fieldId: f.id, name, type, data });
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

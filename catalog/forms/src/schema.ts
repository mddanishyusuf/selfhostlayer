// A form's definition, as the panel's builder saves it and the page renders
// it: its words, layout, theme, thank-you screen and fields. Everything is
// checked here before it's kept, so the page and the answers can trust it.
import { InputError } from "../../lib/http.ts";

export const FIELD_TYPES = ["short_text", "long_text", "email", "number", "url", "phone", "choice", "multi", "dropdown", "yes_no", "rating", "scale", "date", "file", "statement", "hidden", "page_break"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const OPS = ["is", "is_not", "contains", "answered", "not_answered", "gt", "lt"] as const;
export type Op = (typeof OPS)[number];

export interface Condition {
  field: string;
  op: Op;
  value: string;
}

export interface Field {
  id: string;
  type: FieldType;
  label: string;
  help: string;
  required: boolean;
  placeholder: string;
  /** Choice, multi and dropdown. */
  options: string[];
  /** Number bounds; a rating's top (5 or 10). */
  min: number | null;
  max: number | null;
  /** Text answers at most this long. */
  maxLength: number | null;
  /** Hidden fields: the link's query parameter that fills them. */
  param: string;
  /** File fields: types allowed, as an <input accept>. */
  accept: string;
  /** Shown only when an earlier answer says so. */
  showIf: Condition | null;
}

export interface Schema {
  description: string;
  layout: "classic" | "conversational";
  theme: { accent: string; mode: "light" | "dark"; logo: string };
  button: string;
  thanks: { title: string; message: string; redirect: string };
  fields: Field[];
}

/** Types that take no answer. */
export const NO_ANSWER: FieldType[] = ["statement", "page_break"];

const text = (v: unknown, field: string, max: number, fallback = ""): string => {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "string") throw new InputError(field, "must be text");
  if (v.length > max) throw new InputError(field, `must be at most ${max} characters`);
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
};

const num = (v: unknown, field: string): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new InputError(field, "must be a number");
  return n;
};

const url = (v: unknown, field: string): string => {
  const t = text(v, field, 1000).trim();
  if (t && !/^https:\/\/\S+$/i.test(t) && !/^http:\/\/\S+$/i.test(t)) throw new InputError(field, "must be a link starting with https://");
  return t;
};

export function emptySchema(): Schema {
  return {
    description: "",
    layout: "classic",
    theme: { accent: "#4f46e5", mode: "light", logo: "" },
    button: "Submit",
    thanks: { title: "Thanks!", message: "Your answers were sent.", redirect: "" },
    fields: [
      { id: "name", type: "short_text", label: "Your name", help: "", required: true, placeholder: "", options: [], min: null, max: null, maxLength: null, param: "", accept: "", showIf: null },
      { id: "email", type: "email", label: "Your email", help: "", required: true, placeholder: "you@example.com", options: [], min: null, max: null, maxLength: null, param: "", accept: "", showIf: null },
      { id: "message", type: "long_text", label: "Anything else?", help: "", required: false, placeholder: "", options: [], min: null, max: null, maxLength: null, param: "", accept: "", showIf: null },
    ],
  };
}

/** A schema from the builder, checked and with every field's settings filled in. */
export function checkSchema(value: unknown): Schema {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InputError("schema", "must be an object");
  const v = value as Record<string, unknown>;
  const theme = (v.theme ?? {}) as Record<string, unknown>;
  const thanks = (v.thanks ?? {}) as Record<string, unknown>;
  const accent = text(theme.accent, "theme.accent", 7, "#4f46e5");
  if (!/^#[0-9a-f]{6}$/i.test(accent)) throw new InputError("theme.accent", "must be a color like #4f46e5");
  if (!Array.isArray(v.fields)) throw new InputError("fields", "must be a list");
  if (v.fields.length > 200) throw new InputError("fields", "at most 200 fields");
  const seen = new Set<string>();
  const fields = v.fields.map((raw: Record<string, unknown>, i): Field => {
    const f = `fields[${i}]`;
    if (typeof raw !== "object" || raw === null) throw new InputError(f, "must be a field");
    const type = raw.type as FieldType;
    if (!FIELD_TYPES.includes(type)) throw new InputError(`${f}.type`, `must be one of ${FIELD_TYPES.join(", ")}`);
    const id = text(raw.id, `${f}.id`, 40);
    if (!/^[A-Za-z][\w-]{0,39}$/.test(id)) throw new InputError(`${f}.id`, "must be letters, digits, _ and -, starting with a letter");
    if (seen.has(id)) throw new InputError(`${f}.id`, `${id} is used twice`);
    seen.add(id);
    const options = raw.options === undefined ? [] : Array.isArray(raw.options) ? raw.options.map((o, j) => text(o, `${f}.options[${j}]`, 200).trim()).filter(Boolean) : null;
    if (options === null) throw new InputError(`${f}.options`, "must be a list");
    if (["choice", "multi", "dropdown"].includes(type)) {
      if (!options.length) throw new InputError(`${f}.options`, "add at least one choice");
      if (options.length > 100) throw new InputError(`${f}.options`, "at most 100 choices");
      if (new Set(options).size !== options.length) throw new InputError(`${f}.options`, "has the same choice twice");
    }
    let showIf: Condition | null = null;
    if (raw.showIf) {
      const c = raw.showIf as Record<string, unknown>;
      const op = c.op as Op;
      if (!OPS.includes(op)) throw new InputError(`${f}.showIf.op`, `must be one of ${OPS.join(", ")}`);
      const target = String(c.field ?? "");
      // Only earlier fields: an answer can't depend on what comes after it.
      if (!seen.has(target) || target === id) throw new InputError(`${f}.showIf.field`, "must be a field before this one");
      showIf = { field: target, op, value: text(c.value, `${f}.showIf.value`, 200) };
    }
    const max = num(raw.max, `${f}.max`);
    if (type === "rating" && max !== null && max !== 5 && max !== 10) throw new InputError(`${f}.max`, "a rating goes to 5 or 10");
    const param = text(raw.param, `${f}.param`, 40).trim();
    if (type === "hidden" && !/^[A-Za-z][\w-]{0,39}$/.test(param || id)) throw new InputError(`${f}.param`, "must be a query parameter's name");
    const maxLength = num(raw.maxLength, `${f}.maxLength`);
    if (maxLength !== null && (maxLength < 1 || maxLength > 100_000)) throw new InputError(`${f}.maxLength`, "must be 1 to 100000");
    return {
      id,
      type,
      label: text(raw.label, `${f}.label`, 500),
      help: text(raw.help, `${f}.help`, 2000),
      required: raw.required === true && !NO_ANSWER.includes(type) && type !== "hidden",
      placeholder: text(raw.placeholder, `${f}.placeholder`, 200),
      options,
      min: num(raw.min, `${f}.min`),
      max: type === "rating" ? (max ?? 5) : max,
      maxLength,
      param: type === "hidden" ? param || id : "",
      accept: type === "file" ? text(raw.accept, `${f}.accept`, 200).trim() : "",
      showIf,
    };
  });
  return {
    description: text(v.description, "description", 5000),
    layout: v.layout === "conversational" ? "conversational" : "classic",
    theme: { accent, mode: theme.mode === "dark" ? "dark" : "light", logo: url(theme.logo, "theme.logo") },
    button: text(v.button, "button", 60, "Submit").trim() || "Submit",
    thanks: { title: text(thanks.title, "thanks.title", 200, "Thanks!"), message: text(thanks.message, "thanks.message", 5000), redirect: url(thanks.redirect, "thanks.redirect") },
    fields,
  };
}

/** An answer as text, for conditions and summaries: lists joined. */
export const answerText = (a: unknown): string => (Array.isArray(a) ? a.join(", ") : a === undefined || a === null ? "" : String(a));

/**
 * Whether a field shows, given the answers so far (the page runs the same
 * rules). A field after a hidden one it depends on is hidden too.
 */
export function visible(field: Field, answers: Record<string, unknown>, fields: Field[]): boolean {
  const c = field.showIf;
  if (!c) return true;
  const target = fields.find((f) => f.id === c.field);
  if (!target || !visible(target, answers, fields)) return false;
  const a = answers[c.field];
  const has = a !== undefined && a !== null && a !== "" && !(Array.isArray(a) && !a.length);
  switch (c.op) {
    case "answered":
      return has;
    case "not_answered":
      return !has;
    case "is":
      return Array.isArray(a) ? a.includes(c.value) : answerText(a).toLowerCase() === c.value.toLowerCase();
    case "is_not":
      return Array.isArray(a) ? !a.includes(c.value) : answerText(a).toLowerCase() !== c.value.toLowerCase();
    case "contains":
      return answerText(a).toLowerCase().includes(c.value.toLowerCase());
    case "gt":
      return has && Number(a) > Number(c.value);
    case "lt":
      return has && Number(a) < Number(c.value);
  }
}

// A brand's templates, for the transactional API (template: { id, variables })
// and as starting points in the panel: a subject and HTML (written in Markdown
// or HTML in the panel) with {{variables}}.
import type { DatabaseSync } from "node:sqlite";
import { InputError } from "../../lib/http.ts";
import { text } from "./brands.ts";
import { htmlToText, merge, type Vars } from "./render.ts";

export interface Template {
  id: number;
  brandId: number;
  name: string;
  subject: string;
  html: string;
  text: string;
  source: string;
  format: "markdown" | "html";
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: number;
  brand_id: number;
  name: string;
  subject: string;
  html: string;
  text: string;
  source: string;
  format: "markdown" | "html";
  created_at: number;
  updated_at: number;
}

const fromRow = (r: Row): Template => ({ id: r.id, brandId: r.brand_id, name: r.name, subject: r.subject, html: r.html, text: r.text, source: r.source, format: r.format, createdAt: r.created_at, updatedAt: r.updated_at });

export class Templates {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  list(brandId: number): Template[] {
    return (this.#db.prepare("SELECT * FROM templates WHERE brand_id = ? ORDER BY name COLLATE NOCASE").all(brandId) as unknown as Row[]).map(fromRow);
  }

  get(brandId: number, id: number): Template {
    const r = this.#db.prepare("SELECT * FROM templates WHERE id = ? AND brand_id = ?").get(id, brandId) as unknown as Row | undefined;
    if (!r) throw new InputError("template", "no such template", 404);
    return fromRow(r);
  }

  #fields(input: Record<string, unknown>, was?: Template) {
    const pick = (key: string, max: number, fallback: string, required = false) => (input[key] === undefined ? fallback : text(input[key], key, max, { required }));
    return {
      name: pick("name", 120, was?.name ?? "", true),
      subject: pick("subject", 300, was?.subject ?? "").replace(/[\r\n]+/g, " "),
      html: pick("html", 1_000_000, was?.html ?? ""),
      text: pick("text", 500_000, was?.text ?? ""),
      source: pick("source", 1_000_000, was?.source ?? ""),
      format: (input.format === undefined ? (was?.format ?? "markdown") : input.format === "html" ? "html" : "markdown") as "markdown" | "html",
    };
  }

  add(brandId: number, input: Record<string, unknown>): Template {
    const f = this.#fields(input);
    if (!f.name) throw new InputError("name", "is required");
    if ((this.#db.prepare("SELECT count(*) n FROM templates WHERE brand_id = ?").get(brandId) as { n: number }).n >= 500) throw new InputError("name", "at most 500 templates", 409);
    const now = Date.now();
    const id = Number(this.#db.prepare("INSERT INTO templates (brand_id, name, subject, html, text, source, format, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(brandId, f.name, f.subject, f.html, f.text, f.source, f.format, now, now).lastInsertRowid);
    return this.get(brandId, id);
  }

  update(brandId: number, id: number, input: Record<string, unknown>): Template {
    const f = this.#fields(input, this.get(brandId, id));
    this.#db.prepare("UPDATE templates SET name = ?, subject = ?, html = ?, text = ?, source = ?, format = ?, updated_at = ? WHERE id = ?").run(f.name, f.subject, f.html, f.text, f.source, f.format, Date.now(), id);
    return this.get(brandId, id);
  }

  remove(brandId: number, id: number): void {
    this.get(brandId, id);
    this.#db.prepare("DELETE FROM templates WHERE id = ?").run(id);
  }

  /** The template filled in with variables (HTML-escaped in the HTML). */
  render(t: Template, vars: Vars): { subject: string; html: string; text: string } {
    const html = merge(t.html, vars, true);
    return { subject: merge(t.subject, vars, false), html, text: t.text ? merge(t.text, vars, false) : htmlToText(html) };
  }
}

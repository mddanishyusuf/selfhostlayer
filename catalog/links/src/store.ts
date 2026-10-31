// The links, kept in memory so a redirect never waits on the database: loaded
// at start, changed here by the APIs, and reloaded when another process
// changes the database (the other color during a deploy, or a cron job),
// which SQLite's data_version tells within a second.
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Settings } from "./settings.ts";
import { checkExpiry, checkPassword, checkRedirect, checkSlug, checkTags, checkTarget, checkTitle, InputError, RESERVED, type Redirect } from "./validate.ts";

export interface Link {
  id: number;
  slug: string;
  target: string;
  title: string;
  tags: string[];
  redirect: Redirect;
  passQuery: boolean;
  passwordHash: string | null;
  expiresAt: number | null;
  disabled: boolean;
  /** Clicks so far, bots left out. */
  clicks: number;
  createdAt: number;
  updatedAt: number;
}

/** A link as the APIs show it: whether it has a password, never the hash. */
export type PublicLink = Omit<Link, "passwordHash"> & { hasPassword: boolean };
export const toPublic = ({ passwordHash, ...link }: Link): PublicLink => ({ ...link, hasPassword: passwordHash !== null });

export interface LinkInput {
  slug?: unknown;
  target?: unknown;
  title?: unknown;
  tags?: unknown;
  redirect?: unknown;
  passQuery?: unknown;
  /** Text sets it, "" removes it, absent keeps it. */
  password?: unknown;
  expiresAt?: unknown;
  disabled?: unknown;
}

export interface ListOptions {
  q?: string;
  tag?: string;
  sort?: "created" | "clicks" | "slug";
  limit?: number;
  offset?: number;
}

interface Row {
  id: number;
  slug: string;
  target: string;
  title: string;
  tags: string;
  redirect: number;
  pass_query: number;
  password_hash: string | null;
  expires_at: number | null;
  disabled: number;
  clicks: number;
  created_at: number;
  updated_at: number;
}

const fromRow = (r: Row): Link => ({
  id: r.id,
  slug: r.slug,
  target: r.target,
  title: r.title,
  tags: JSON.parse(r.tags) as string[],
  redirect: r.redirect as Redirect,
  passQuery: r.pass_query === 1,
  passwordHash: r.password_hash,
  expiresAt: r.expires_at,
  disabled: r.disabled === 1,
  clicks: r.clicks,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** No 0, 1, i, l or o: random slugs read aloud without mix-ups. */
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function passwordMatches(stored: string, password: string): boolean {
  const [scheme, n, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64url");
  const got = scryptSync(password, Buffer.from(salt, "base64url"), want.length, { N: Number(n), r: 8, p: 1 });
  return timingSafeEqual(want, got);
}

const boolOf = (value: unknown, field: string): boolean => {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  throw new InputError(field, "must be true or false");
};

export class Store {
  readonly #db: DatabaseSync;
  readonly #settings: () => Settings;
  #bySlug = new Map<string, Link>();
  #byId = new Map<number, Link>();
  #version = -1;

  constructor(db: DatabaseSync, settings: () => Settings) {
    this.#db = db;
    this.#settings = settings;
    this.reload();
  }

  reload(): void {
    const rows = this.#db.prepare("SELECT * FROM links").all() as unknown as Row[];
    this.#bySlug = new Map();
    this.#byId = new Map();
    for (const link of rows.map(fromRow)) this.#put(link);
    this.#version = this.#dataVersion();
  }

  /** Reloads when another connection changed the database since the last look. */
  refresh(): boolean {
    if (this.#dataVersion() === this.#version) return false;
    this.reload();
    return true;
  }

  #dataVersion(): number {
    return (this.#db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
  }

  #put(link: Link): void {
    this.#bySlug.set(link.slug, link);
    this.#byId.set(link.id, link);
  }

  get size(): number {
    return this.#byId.size;
  }

  bySlug(slug: string): Link | undefined {
    return this.#bySlug.get(slug.toLowerCase());
  }

  byId(id: number): Link | undefined {
    return this.#byId.get(id);
  }

  list(o: ListOptions = {}): { links: Link[]; total: number } {
    const q = o.q?.trim().toLowerCase();
    let links = [...this.#byId.values()];
    if (q) links = links.filter((l) => l.slug.includes(q) || l.target.toLowerCase().includes(q) || l.title.toLowerCase().includes(q));
    if (o.tag) links = links.filter((l) => l.tags.includes(o.tag!));
    const sort = o.sort ?? "created";
    links.sort((a, b) => (sort === "clicks" ? b.clicks - a.clicks || b.id - a.id : sort === "slug" ? a.slug.localeCompare(b.slug) : b.id - a.id));
    const offset = Math.max(0, o.offset ?? 0);
    const limit = Math.min(Math.max(1, o.limit ?? 50), 500);
    return { links: links.slice(offset, offset + limit), total: links.length };
  }

  /** Every tag with how many links carry it, most used first. */
  tags(): { tag: string; links: number }[] {
    const counts = new Map<string, number>();
    for (const l of this.#byId.values()) for (const t of l.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].map(([tag, links]) => ({ tag, links })).sort((a, b) => b.links - a.links || a.tag.localeCompare(b.tag));
  }

  #randomSlug(): string {
    for (;;) {
      const slug = Array.from({ length: 7 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
      if (!this.#bySlug.has(slug) && !RESERVED.has(slug)) return slug;
    }
  }

  create(input: LinkInput): Link {
    const target = checkTarget(input.target);
    const slug = input.slug === undefined || input.slug === null || input.slug === "" ? this.#randomSlug() : checkSlug(input.slug);
    if (this.#bySlug.has(slug)) throw new InputError("slug", `${slug} is taken`, 409);
    const now = Date.now();
    const link: Link = {
      id: 0,
      slug,
      target,
      title: checkTitle(input.title),
      tags: checkTags(input.tags),
      redirect: input.redirect === undefined || input.redirect === null || input.redirect === "" ? this.#settings().defaultRedirect : checkRedirect(input.redirect),
      passQuery: input.passQuery === undefined ? true : boolOf(input.passQuery, "passQuery"),
      passwordHash: input.password === undefined || input.password === null || input.password === "" ? null : hashPassword(checkPassword(input.password)),
      expiresAt: checkExpiry(input.expiresAt),
      disabled: input.disabled === undefined ? false : boolOf(input.disabled, "disabled"),
      clicks: 0,
      createdAt: now,
      updatedAt: now,
    };
    const r = this.#db
      .prepare(
        `INSERT INTO links (slug, target, title, tags, redirect, pass_query, password_hash, expires_at, disabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(link.slug, link.target, link.title, JSON.stringify(link.tags), link.redirect, link.passQuery ? 1 : 0, link.passwordHash, link.expiresAt, link.disabled ? 1 : 0, now, now);
    link.id = Number(r.lastInsertRowid);
    this.#put(link);
    return link;
  }

  update(id: number, input: LinkInput): Link {
    const old = this.#byId.get(id);
    if (!old) throw new InputError("id", "no such link", 404);
    const link: Link = { ...old, tags: [...old.tags] };
    if (input.slug !== undefined) {
      link.slug = checkSlug(input.slug);
      const holder = this.#bySlug.get(link.slug);
      if (holder && holder.id !== id) throw new InputError("slug", `${link.slug} is taken`, 409);
    }
    if (input.target !== undefined) link.target = checkTarget(input.target);
    if (input.title !== undefined) link.title = checkTitle(input.title);
    if (input.tags !== undefined) link.tags = checkTags(input.tags);
    if (input.redirect !== undefined) link.redirect = checkRedirect(input.redirect);
    if (input.passQuery !== undefined) link.passQuery = boolOf(input.passQuery, "passQuery");
    if (input.password !== undefined) link.passwordHash = input.password === null || input.password === "" ? null : hashPassword(checkPassword(input.password));
    if (input.expiresAt !== undefined) link.expiresAt = checkExpiry(input.expiresAt);
    if (input.disabled !== undefined) link.disabled = boolOf(input.disabled, "disabled");
    link.updatedAt = Date.now();
    this.#db
      .prepare("UPDATE links SET slug = ?, target = ?, title = ?, tags = ?, redirect = ?, pass_query = ?, password_hash = ?, expires_at = ?, disabled = ?, updated_at = ? WHERE id = ?")
      .run(link.slug, link.target, link.title, JSON.stringify(link.tags), link.redirect, link.passQuery ? 1 : 0, link.passwordHash, link.expiresAt, link.disabled ? 1 : 0, link.updatedAt, id);
    this.#bySlug.delete(old.slug);
    this.#put(link);
    return link;
  }

  /** Deletes the link and its clicks. */
  remove(id: number): void {
    const link = this.#byId.get(id);
    if (!link) throw new InputError("id", "no such link", 404);
    this.#db.exec("BEGIN");
    try {
      for (const table of ["clicks", "clicks_daily"]) this.#db.prepare(`DELETE FROM ${table} WHERE link_id = ?`).run(id);
      this.#db.prepare("DELETE FROM links WHERE id = ?").run(id);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    this.#byId.delete(id);
    this.#bySlug.delete(link.slug);
  }

  /** Counts written by a flush of clicks, applied to the links in memory. */
  addClicks(counts: Map<number, number>): void {
    for (const [id, n] of counts) {
      const link = this.#byId.get(id);
      if (link) link.clicks += n;
    }
  }
}

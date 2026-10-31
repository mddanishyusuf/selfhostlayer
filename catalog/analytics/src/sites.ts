// The sites Analytics counts: each a domain (example.com), with its
// subdomains if the owner chooses; www. always counts as the site itself.
// Kept in memory, since every event looks its site up.
import type { DatabaseSync } from "node:sqlite";
import { InputError } from "../../lib/http.ts";

export interface Site {
  id: number;
  domain: string;
  subdomains: boolean;
  createdAt: number;
}

interface Row {
  id: number;
  domain: string;
  subdomains: number;
  created_at: number;
}

const fromRow = (r: Row): Site => ({ id: r.id, domain: r.domain, subdomains: r.subdomains === 1, createdAt: r.created_at });

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/** A domain as stored: lowercase, no scheme, path or www. */
export function checkDomain(value: unknown): string {
  if (typeof value !== "string") throw new InputError("domain", "must be a domain like example.com");
  let text = value.trim().toLowerCase();
  if (/^https?:\/\//.test(text)) {
    try {
      text = new URL(text).hostname;
    } catch {
      throw new InputError("domain", "must be a domain like example.com");
    }
  }
  text = text.replace(/^www\./, "").replace(/\.$/, "");
  if (!DOMAIN.test(text)) throw new InputError("domain", "must be a domain like example.com");
  return text;
}

export class Sites {
  readonly #db: DatabaseSync;
  #byDomain = new Map<string, Site>();
  #byId = new Map<number, Site>();
  #version = -1;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.reload();
  }

  reload(): void {
    this.#byDomain = new Map();
    this.#byId = new Map();
    for (const site of (this.#db.prepare("SELECT * FROM sites").all() as unknown as Row[]).map(fromRow)) {
      this.#byDomain.set(site.domain, site);
      this.#byId.set(site.id, site);
    }
    this.#version = (this.#db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
  }

  /** Reloads when another process (the other color during a deploy) changed the database. */
  refresh(): boolean {
    if ((this.#db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version === this.#version) return false;
    this.reload();
    return true;
  }

  list(): Site[] {
    return [...this.#byId.values()].sort((a, b) => a.domain.localeCompare(b.domain));
  }

  byId(id: number): Site | undefined {
    return this.#byId.get(id);
  }

  byDomain(domain: string): Site | undefined {
    return this.#byDomain.get(domain.toLowerCase().replace(/^www\./, ""));
  }

  /** Whether a page on this host belongs to the site. */
  owns(site: Site, host: string): boolean {
    const h = host.toLowerCase().replace(/\.$/, "");
    return h === site.domain || h === `www.${site.domain}` || (site.subdomains && h.endsWith(`.${site.domain}`));
  }

  add(input: { domain?: unknown; subdomains?: unknown }): Site {
    const domain = checkDomain(input.domain);
    if (this.#byDomain.has(domain)) throw new InputError("domain", `${domain} is already a site`, 409);
    const site: Site = { id: 0, domain, subdomains: input.subdomains === true, createdAt: Date.now() };
    site.id = Number(this.#db.prepare("INSERT INTO sites (domain, subdomains, created_at) VALUES (?, ?, ?)").run(domain, site.subdomains ? 1 : 0, site.createdAt).lastInsertRowid);
    this.#byDomain.set(domain, site);
    this.#byId.set(site.id, site);
    return site;
  }

  update(id: number, input: { subdomains?: unknown }): Site {
    const site = this.#byId.get(id);
    if (!site) throw new InputError("id", "no such site", 404);
    if (input.subdomains !== undefined) {
      if (typeof input.subdomains !== "boolean") throw new InputError("subdomains", "must be true or false");
      site.subdomains = input.subdomains;
      this.#db.prepare("UPDATE sites SET subdomains = ? WHERE id = ?").run(site.subdomains ? 1 : 0, id);
    }
    return site;
  }

  /** Deletes the site and everything counted for it. */
  remove(id: number): void {
    const site = this.#byId.get(id);
    if (!site) throw new InputError("id", "no such site", 404);
    this.#db.exec("BEGIN");
    try {
      for (const table of ["events", "sessions", "goals", "revenue_sources", "payments", "customers"]) this.#db.prepare(`DELETE FROM ${table} WHERE site_id = ?`).run(id);
      this.#db.prepare("DELETE FROM sites WHERE id = ?").run(id);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    this.#byId.delete(id);
    this.#byDomain.delete(site.domain);
  }
}

// A brand's sending domains. Mail goes out only from a verified domain:
//   SMTP brands: our own DKIM key (RSA 2048, its private half encrypted), the
//     TXT record at <selector>._domainkey.<domain> found in public DNS;
//   SES brands: the domain's identity in SES, verified by its three Easy DKIM
//     CNAMEs, as SES says.
// SPF and DMARC are looked up too and explained, never required: with DKIM
// signing for the domain, DMARC passes on alignment alone.
import { Resolver } from "node:dns/promises";
import type { DatabaseSync } from "node:sqlite";
import { InputError } from "../../lib/http.ts";
import type { Brands } from "./brands.ts";
import { dkimRecord, newKeyPair } from "./dkim.ts";
import { domainOf } from "./mime.ts";
import type { Secrets } from "./secrets.ts";

export interface DnsRecord {
  purpose: "DKIM" | "SPF" | "DMARC";
  type: "TXT" | "CNAME";
  name: string;
  value: string;
  /** Sending waits for it (DKIM); the others are advice. */
  required: boolean;
  /** At the last check: found as it should be, found otherwise, or not looked at yet. */
  ok: boolean | null;
  found: string | null;
}

export interface Domain {
  id: number;
  brandId: number;
  domain: string;
  status: "pending" | "verified" | "failed";
  records: DnsRecord[];
  checkedAt: number | null;
  verifiedAt: number | null;
  createdAt: number;
}

interface Row {
  id: number;
  brand_id: number;
  domain: string;
  selector: string;
  dkim_private: string | null;
  dkim_public: string | null;
  ses_tokens: string | null;
  status: "pending" | "verified" | "failed";
  checks: string;
  checked_at: number | null;
  verified_at: number | null;
  created_at: number;
}

type Checks = Partial<Record<string, { ok: boolean; found: string | null }>>;

export interface Dns {
  txt(name: string): Promise<string[]>;
  cname(name: string): Promise<string[]>;
}

/** Public DNS (Cloudflare's and Google's resolvers), so what the world sees is what's checked. */
export function publicDns(): Dns {
  const r = new Resolver({ timeout: 4000, tries: 2 });
  r.setServers(["1.1.1.1", "8.8.8.8"]);
  const none = (err: NodeJS.ErrnoException): string[] => {
    if (["ENOTFOUND", "ENODATA", "ESERVFAIL", "ETIMEOUT", "ECONNREFUSED", "EREFUSED"].includes(err.code ?? "")) return [];
    throw err;
  };
  return {
    txt: (name) => r.resolveTxt(name).then((rows) => rows.map((parts) => parts.join("")), none),
    cname: (name) => r.resolveCname(name).catch(none),
  };
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

export class Domains {
  readonly #db: DatabaseSync;
  readonly #secrets: Secrets;
  readonly #brands: () => Brands;
  readonly #dns: Dns;

  constructor(o: { db: DatabaseSync; secrets: Secrets; brands: () => Brands; dns?: Dns }) {
    this.#db = o.db;
    this.#secrets = o.secrets;
    this.#brands = o.brands;
    this.#dns = o.dns ?? publicDns();
  }

  #row(id: number): Row | undefined {
    return this.#db.prepare("SELECT * FROM domains WHERE id = ?").get(id) as unknown as Row | undefined;
  }

  #records(r: Row): DnsRecord[] {
    const brand = this.#brands().get(r.brand_id);
    const checks = JSON.parse(r.checks) as Checks;
    const check = (key: string) => ({ ok: checks[key]?.ok ?? null, found: checks[key]?.found ?? null });
    const out: DnsRecord[] = [];
    if (brand?.provider === "ses") {
      const tokens = r.ses_tokens ? (JSON.parse(r.ses_tokens) as string[]) : [];
      tokens.forEach((t, i) => out.push({ purpose: "DKIM", type: "CNAME", name: `${t}._domainkey.${r.domain}`, value: `${t}.dkim.amazonses.com`, required: true, ...check(`ses${i}`) }));
    } else if (r.dkim_public) {
      out.push({ purpose: "DKIM", type: "TXT", name: `${r.selector}._domainkey.${r.domain}`, value: dkimRecord(r.dkim_public), required: true, ...check("dkim") });
    }
    out.push({ purpose: "SPF", type: "TXT", name: r.domain, value: brand?.provider === "ses" ? "v=spf1 include:amazonses.com ~all" : "v=spf1 include:<your provider's SPF> ~all", required: false, ...check("spf") });
    out.push({ purpose: "DMARC", type: "TXT", name: `_dmarc.${r.domain}`, value: "v=DMARC1; p=none;", required: false, ...check("dmarc") });
    return out;
  }

  #from(r: Row): Domain {
    return { id: r.id, brandId: r.brand_id, domain: r.domain, status: r.status, records: this.#records(r), checkedAt: r.checked_at, verifiedAt: r.verified_at, createdAt: r.created_at };
  }

  list(brandId: number): Domain[] {
    return (this.#db.prepare("SELECT * FROM domains WHERE brand_id = ? ORDER BY domain").all(brandId) as unknown as Row[]).map((r) => this.#from(r));
  }

  must(brandId: number, id: number): Domain {
    const r = this.#row(id);
    if (!r || r.brand_id !== brandId) throw new InputError("domain", "no such domain", 404);
    return this.#from(r);
  }

  /** Adds a domain: a DKIM key of its own, and for an SES brand, its identity in SES. */
  async add(brandId: number, value: unknown): Promise<Domain> {
    const brand = this.#brands().must(brandId);
    if (typeof value !== "string") throw new InputError("domain", "must be a domain like example.com");
    const domain = value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/\.$/, "");
    if (!DOMAIN.test(domain)) throw new InputError("domain", "must be a domain like example.com");
    if (this.#db.prepare("SELECT 1 FROM domains WHERE brand_id = ? AND domain = ?").get(brandId, domain)) throw new InputError("domain", `${domain} is already a domain of this brand`, 409);
    const { privatePem, publicBase64 } = newKeyPair();
    let tokens: string[] | null = null;
    if (brand.provider === "ses") tokens = (await this.#brands().ses(brandId).createIdentity(domain)).tokens;
    const id = Number(
      this.#db
        .prepare("INSERT INTO domains (brand_id, domain, selector, dkim_private, dkim_public, ses_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(brandId, domain, `shl${brandId}`, this.#secrets.seal(privatePem), publicBase64, tokens ? JSON.stringify(tokens) : null, Date.now()).lastInsertRowid,
    );
    return this.#from(this.#row(id)!);
  }

  /** Looks the records up again; verified once DKIM is there (or SES says the identity is verified). */
  async verify(brandId: number, id: number): Promise<Domain> {
    const d = this.must(brandId, id);
    const r = this.#row(id)!;
    const brand = this.#brands().must(brandId);
    const checks: Checks = {};
    let verified = false;
    if (brand.provider === "ses") {
      const ses = this.#brands().ses(brandId);
      let tokens = r.ses_tokens ? (JSON.parse(r.ses_tokens) as string[]) : [];
      if (!tokens.length) {
        tokens = (await ses.createIdentity(d.domain)).tokens;
        this.#db.prepare("UPDATE domains SET ses_tokens = ? WHERE id = ?").run(JSON.stringify(tokens), id);
      }
      const identity = await ses.identity(d.domain);
      verified = identity.verified;
      await Promise.all(
        tokens.map(async (t, i) => {
          const found = (await this.#dns.cname(`${t}._domainkey.${d.domain}`))[0] ?? null;
          checks[`ses${i}`] = { ok: found?.toLowerCase().replace(/\.$/, "") === `${t}.dkim.amazonses.com`, found };
        }),
      );
    } else {
      const found = (await this.#dns.txt(`${r.selector}._domainkey.${d.domain}`)).find((t) => /\bp=/.test(t)) ?? null;
      const p = found ? /\bp=([A-Za-z0-9+/=\s]+)/.exec(found)?.[1]?.replace(/\s+/g, "") : null;
      verified = p === r.dkim_public;
      checks.dkim = { ok: verified, found };
    }
    const spf = (await this.#dns.txt(d.domain)).find((t) => /^v=spf1\b/i.test(t)) ?? null;
    checks.spf = { ok: spf !== null && (brand.provider !== "ses" || /include:amazonses\.com/i.test(spf)), found: spf };
    const dmarc = (await this.#dns.txt(`_dmarc.${d.domain}`)).find((t) => /^v=DMARC1\b/i.test(t)) ?? null;
    checks.dmarc = { ok: dmarc !== null, found: dmarc };
    const now = Date.now();
    this.#db
      .prepare("UPDATE domains SET checks = ?, checked_at = ?, status = ?, verified_at = CASE WHEN ? THEN coalesce(verified_at, ?) ELSE NULL END WHERE id = ?")
      .run(JSON.stringify(checks), now, verified ? "verified" : "failed", verified ? 1 : 0, now, id);
    return this.#from(this.#row(id)!);
  }

  async remove(brandId: number, id: number): Promise<void> {
    const d = this.must(brandId, id);
    const brand = this.#brands().must(brandId);
    if (brand.provider === "ses") await this.#brands().ses(brandId).deleteIdentity(d.domain).catch(() => {});
    this.#db.prepare("DELETE FROM domains WHERE id = ?").run(id);
  }

  /** Whether the brand may send from this address: its domain is one of the brand's, verified. */
  verifiedFor(brandId: number, email: string): boolean {
    return this.#db.prepare("SELECT 1 FROM domains WHERE brand_id = ? AND domain = ? AND status = 'verified'").get(brandId, domainOf(email)) !== undefined;
  }

  /** The brand's DKIM keys, by domain, for signing mail sent over SMTP. */
  dkimFor(brandId: number): (domain: string) => { selector: string; privateKey: string } | null {
    return (domain) => {
      const r = this.#db.prepare("SELECT selector, dkim_private FROM domains WHERE brand_id = ? AND domain = ?").get(brandId, domain.toLowerCase()) as { selector: string; dkim_private: string | null } | undefined;
      return r?.dkim_private ? { selector: r.selector, privateKey: this.#secrets.open(r.dkim_private) } : null;
    };
  }
}

// Shield (PLAN-EMAIL-2.md): keeps bad and spam addresses off a brand's lists.
// Eight checks, each set per brand to refuse, flag or off. The address checks
// (invalid, temporary, spam-listed domain, free webmail, bounced elsewhere)
// run on every way in: sign-up forms, the API, imports, syncs and Clean the
// list. The sign-up checks (scripted browsers, spam-listed and abusive IPs)
// need a browser's request, so they run on sign-up forms only. The lists come
// from public downloads kept in data/shield/ and refreshed in the background;
// the IP of a sign-up is used while it's checked and never stored.
import { promises as dnsPromises } from "node:dns";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isIPv4, isIPv6 } from "node:net";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { InputError } from "../../lib/http.ts";
import type { Secrets } from "../../lib/secrets.ts";
import type { Verdicts } from "./contacts.ts";
import { getSetting, setSetting } from "./db.ts";

export const CHECKS = ["invalid", "disposable", "spamDomain", "freeMail", "bounced", "scripted", "spamIp", "abusiveIp"] as const;
export type Check = (typeof CHECKS)[number];
export type Action = "refuse" | "flag" | "off";
/** The checks that need only the address: imports, syncs, the API and Clean the list run these. */
export const ADDRESS_CHECKS: readonly Check[] = ["invalid", "disposable", "spamDomain", "freeMail", "bounced"];

export const CHECK_LABELS: Record<Check, string> = {
  invalid: "Invalid email",
  disposable: "Temporary email",
  spamDomain: "Spam-listed domain",
  freeMail: "Free webmail",
  bounced: "Bounced elsewhere",
  scripted: "Scripted browser",
  spamIp: "Spam-listed IP",
  abusiveIp: "Abusive IP",
};

export interface ShieldSettings {
  checks: Record<Check, Action>;
  /** Sign-ups from data-center addresses (cloud servers, hosting) are fine: a B2B tool's users may be on a VPN. */
  allowDatacenter: boolean;
}

export const DEFAULT_SETTINGS: ShieldSettings = {
  checks: { invalid: "refuse", disposable: "refuse", spamDomain: "refuse", freeMail: "off", bounced: "flag", scripted: "refuse", spamIp: "refuse", abusiveIp: "refuse" },
  allowDatacenter: false,
};

export function readShieldSettings(raw: string | null | undefined): ShieldSettings {
  const saved = raw ? (JSON.parse(raw) as Partial<ShieldSettings>) : {};
  return { checks: { ...DEFAULT_SETTINGS.checks, ...(saved.checks ?? {}) }, allowDatacenter: saved.allowDatacenter ?? DEFAULT_SETTINGS.allowDatacenter };
}

export function checkShieldSettings(input: Record<string, unknown>, was: ShieldSettings): ShieldSettings {
  const next: ShieldSettings = { checks: { ...was.checks }, allowDatacenter: was.allowDatacenter };
  if (input.checks !== undefined) {
    if (typeof input.checks !== "object" || input.checks === null || Array.isArray(input.checks)) throw new InputError("checks", "must map checks to refuse, flag or off");
    for (const [k, v] of Object.entries(input.checks as Record<string, unknown>)) {
      if (!(CHECKS as readonly string[]).includes(k)) throw new InputError("checks", `no check ${k.slice(0, 40)}`);
      if (v !== "refuse" && v !== "flag" && v !== "off") throw new InputError("checks", `${k} must be refuse, flag or off`);
      next.checks[k as Check] = v;
    }
  }
  if (input.allowDatacenter !== undefined) next.allowDatacenter = input.allowDatacenter === true;
  return next;
}

/** What a batch's verdicts come to: distinct addresses, how many fine, flagged or refused, by check with a few examples. */
export interface VerdictSummary {
  total: number;
  ok: number;
  flag: number;
  refuse: number;
  byCheck: Partial<Record<Check, { action: "refuse" | "flag"; count: number }>>;
  examples: Partial<Record<Check, { email: string; detail: string }[]>>;
}

export interface Verdict {
  check: Check;
  /** A few words for the panel: "no mail server for example.con". Never the whole address. */
  detail: string;
}

export interface Decision {
  outcome: "ok" | "flag" | "refuse";
  /** What failed and what each is set to do (off checks don't run). */
  verdicts: (Verdict & { action: Exclude<Action, "off"> })[];
}

/** refuse if any failed check refuses, flag if any flags, else ok. */
export function decide(verdicts: Verdict[], settings: ShieldSettings): Decision {
  const on = verdicts.map((v) => ({ ...v, action: settings.checks[v.check] })).filter((v): v is Verdict & { action: Exclude<Action, "off"> } => v.action !== "off");
  return { outcome: on.some((v) => v.action === "refuse") ? "refuse" : on.length ? "flag" : "ok", verdicts: on };
}

// ------------------------------------------------------------- the lists

interface ListSpec {
  url: string;
  /** How often it's downloaded again. */
  everyMs: number;
  kind: "domains" | "ips" | "cidrs";
  gzip?: boolean;
}

const DAY = 86_400_000;

export const LISTS: Record<string, ListSpec> = {
  // disposable-email-domains (CC0).
  disposable: { url: "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf", everyMs: 7 * DAY, kind: "domains" },
  // StopForumSpam's domains seen in spam, and its IPs seen in the last 30 days (IPv4 and IPv6).
  toxicDomains: { url: "https://www.stopforumspam.com/downloads/toxic_domains_whole.txt", everyMs: DAY, kind: "domains" },
  spamIps: { url: "https://www.stopforumspam.com/downloads/listed_ip_30_ipv46.gz", everyMs: DAY, kind: "ips", gzip: true },
  // The Tor Project's exit nodes.
  torExits: { url: "https://check.torproject.org/torbulkexitlist", everyMs: DAY, kind: "ips" },
  // Cloud and hosting ranges (X4BNet/lists_vpn, MIT).
  datacenters: { url: "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt", everyMs: 7 * DAY, kind: "cidrs" },
};

/** Free webmail providers, for lists that want work addresses. */
export const FREE_MAIL = new Set(
  (
    "gmail.com googlemail.com yahoo.com yahoo.co.uk yahoo.co.in yahoo.fr yahoo.de yahoo.es yahoo.it yahoo.com.br ymail.com rocketmail.com " +
    "outlook.com hotmail.com hotmail.co.uk hotmail.fr hotmail.de hotmail.it hotmail.es live.com live.co.uk live.fr msn.com passport.com " +
    "icloud.com me.com mac.com aol.com aim.com gmx.com gmx.net gmx.de gmx.at gmx.ch web.de mail.com email.com usa.com " +
    "proton.me protonmail.com protonmail.ch pm.me tutanota.com tutanota.de tuta.io tutamail.com zoho.com zohomail.com yandex.com yandex.ru ya.ru mail.ru inbox.ru list.ru bk.ru rambler.ru " +
    "qq.com 163.com 126.com yeah.net sina.com sohu.com naver.com daum.net hanmail.net rediffmail.com fastmail.com fastmail.fm hushmail.com " +
    "libero.it virgilio.it tiscali.it orange.fr wanadoo.fr free.fr laposte.net sfr.fr t-online.de freenet.de seznam.cz wp.pl o2.pl interia.pl onet.pl " +
    "btinternet.com sky.com virginmedia.com ntlworld.com talktalk.net comcast.net verizon.net att.net sbcglobal.net bellsouth.net cox.net charter.net earthlink.net optonline.net " +
    "bigpond.com bigpond.net.au optusnet.com.au shaw.ca rogers.com sympatico.ca uol.com.br bol.com.br terra.com.br hey.com duck.com"
  ).split(" "),
);

const ipv4Int = (ip: string): number | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!/^\d{1,3}$/.test(p) || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
};

/** An IPv6 address written one way: lowercase, the :: expanded, leading zeros dropped. */
export function normalizeIpv6(ip: string): string | null {
  if (!isIPv6(ip)) return null;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const a = head ? head.split(":") : [];
  const b = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = ip.includes("::") ? [...a, ...Array(8 - a.length - b.length).fill("0"), ...b] : a;
  return groups.map((g) => g.replace(/^0+(?=.)/, "")).join(":");
}

class IpSet {
  readonly v4 = new Set<number>();
  readonly v6 = new Set<string>();
  add(ip: string): void {
    const n = ipv4Int(ip);
    if (n !== null) this.v4.add(n);
    else {
      const v6 = normalizeIpv6(ip);
      if (v6) this.v6.add(v6);
    }
  }
  has(ip: string): boolean {
    const n = ipv4Int(ip);
    if (n !== null) return this.v4.has(n);
    const v6 = normalizeIpv6(ip);
    return v6 !== null && this.v6.has(v6);
  }
  get size(): number {
    return this.v4.size + this.v6.size;
  }
}

/** IPv4 ranges, merged and sorted, looked up by binary search. */
class Ranges {
  starts: number[] = [];
  ends: number[] = [];
  static parse(lines: string[]): Ranges {
    const pairs: [number, number][] = [];
    for (const line of lines) {
      const [ip = "", bits = "32"] = line.split("/");
      const start = ipv4Int(ip);
      const b = Number(bits);
      if (start === null || !Number.isInteger(b) || b < 8 || b > 32) continue;
      const size = 2 ** (32 - b);
      const base = start - (start % size);
      pairs.push([base, base + size - 1]);
    }
    pairs.sort((x, y) => x[0] - y[0]);
    const r = new Ranges();
    for (const [s, e] of pairs) {
      const last = r.ends.length - 1;
      if (last >= 0 && s <= r.ends[last]! + 1) r.ends[last] = Math.max(r.ends[last]!, e);
      else {
        r.starts.push(s);
        r.ends.push(e);
      }
    }
    return r;
  }
  has(ip: string): boolean {
    const n = ipv4Int(ip);
    if (n === null) return false;
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid]! > n) hi = mid - 1;
      else if (this.ends[mid]! < n) lo = mid + 1;
      else return true;
    }
    return false;
  }
  get size(): number {
    return this.starts.length;
  }
}

export interface ListStatus {
  name: string;
  entries: number;
  /** When the copy on disk was downloaded; null before the first download. */
  updatedAt: number | null;
  error: string | null;
}

/** A domain or one of its parents is in the set (mail.sub.mailinator.com → mailinator.com). */
function domainIn(set: Set<string>, domain: string): boolean {
  let d = domain;
  for (;;) {
    if (set.has(d)) return true;
    const dot = d.indexOf(".");
    if (dot < 0 || d.indexOf(".", dot + 1) < 0) return false;
    d = d.slice(dot + 1);
  }
}

// ------------------------------------------------------------- Shield

export interface ShieldOptions {
  db: DatabaseSync;
  secrets: Secrets;
  /** data/shield: the downloaded lists. */
  dir: string;
  fetch?: typeof fetch;
  /** Tests: answers for MX, A and AAAA lookups. */
  dns?: Pick<typeof dnsPromises, "resolveMx" | "resolve4" | "resolve6">;
}

export interface SignupInput {
  email: string;
  ip: string | null;
  userAgent: string | undefined;
  /** The honeypot field had something in it. */
  honeypot: boolean;
  /** From the form snippet: navigator.webdriver, and ms from the page load to the submit. */
  webdriver?: boolean;
  elapsedMs?: number;
}

const SCRIPTED_UA = /HeadlessChrome|PhantomJS|Puppeteer|Playwright|Selenium|webdriver|curl\/|Wget|python-requests|python-urllib|aiohttp|httpx|Go-http-client|node-fetch|undici|axios\/|libwww-perl|Java\/|okhttp|HTTPie|Scrapy|Postman|insomnia/i;
const MX_TTL = DAY;
const MX_FAIL_TTL = 3_600_000;

export class Shield {
  readonly #db: DatabaseSync;
  readonly #secrets: Secrets;
  readonly #dir: string;
  readonly #fetch: typeof fetch;
  readonly #dns: Pick<typeof dnsPromises, "resolveMx" | "resolve4" | "resolve6">;
  #domains: Record<"disposable" | "toxicDomains", Set<string>> = { disposable: new Set(), toxicDomains: new Set() };
  #ips: Record<"spamIps" | "torExits", IpSet> = { spamIps: new IpSet(), torExits: new IpSet() };
  #datacenters = new Ranges();
  #errors = new Map<string, string>();
  #mx = new Map<string, { ok: boolean | null; detail: string; at: number }>();
  #abuse = new Map<string, { score: number; at: number }>();
  #refreshing: Promise<void> | null = null;

  constructor(o: ShieldOptions) {
    this.#db = o.db;
    this.#secrets = o.secrets;
    this.#dir = o.dir;
    this.#fetch = o.fetch ?? fetch;
    this.#dns = o.dns ?? dnsPromises;
    mkdirSync(this.#dir, { recursive: true });
    for (const name of Object.keys(LISTS)) this.#load(name);
  }

  // Settings

  settings(brandId: number): ShieldSettings {
    const r = this.#db.prepare("SELECT shield FROM brands WHERE id = ?").get(brandId) as { shield: string } | undefined;
    if (!r) throw new InputError("brand", "no such brand", 404);
    return readShieldSettings(r.shield);
  }

  setSettings(brandId: number, input: Record<string, unknown>): ShieldSettings {
    const next = checkShieldSettings(input, this.settings(brandId));
    this.#db.prepare("UPDATE brands SET shield = ? WHERE id = ?").run(JSON.stringify(next), brandId);
    return next;
  }

  /** AbuseIPDB's key, for every brand on this install: sealed at rest. */
  hasAbuseKey(): boolean {
    return getSetting(this.#db, "abuseipdbKey") !== null;
  }

  setAbuseKey(key: unknown): void {
    if (key === null || key === "") {
      this.#db.prepare("DELETE FROM settings WHERE key = 'abuseipdbKey'").run();
      return;
    }
    if (typeof key !== "string" || !/^[a-f0-9]{80}$/i.test(key.trim())) throw new InputError("key", "an AbuseIPDB key is 80 letters and digits");
    setSetting(this.#db, "abuseipdbKey", this.#secrets.seal(key.trim()));
    this.#abuse.clear();
  }

  // The lists

  #file = (name: string) => join(this.#dir, `${name}.txt`);

  #load(name: string): void {
    const spec = LISTS[name]!;
    let text: string;
    try {
      text = readFileSync(this.#file(name), "utf8");
    } catch {
      return;
    }
    // One pass over the text, no arrays of lines: a 1 MB list split, trimmed and
    // lowercased in steps left tens of MB of garbage the process kept.
    const each = (take: (line: string) => void) => {
      for (let start = 0; start < text.length; ) {
        let end = text.indexOf("\n", start);
        if (end < 0) end = text.length;
        const line = text.slice(start, end).trim();
        start = end + 1;
        if (line && line[0] !== "#") take(line.toLowerCase());
      }
    };
    if (spec.kind === "domains") {
      const set = new Set<string>();
      each((l) => set.add(l));
      this.#domains[name as "disposable"] = set;
    } else if (spec.kind === "ips") {
      const set = new IpSet();
      each((l) => set.add(l.split(/\s/, 1)[0]!));
      this.#ips[name as "spamIps"] = set;
    } else {
      const lines: string[] = [];
      each((l) => lines.push(l));
      this.#datacenters = Ranges.parse(lines);
    }
  }

  #age(name: string): number | null {
    try {
      return statSync(this.#file(name)).mtimeMs;
    } catch {
      return null;
    }
  }

  /** Downloads the lists that are due (or all of them with force); a failed download keeps the last copy. */
  refresh(force = false): Promise<void> {
    this.#refreshing ??= (async () => {
      for (const [name, spec] of Object.entries(LISTS)) {
        const age = this.#age(name);
        if (!force && age !== null && Date.now() - age < spec.everyMs) continue;
        try {
          const res = await this.#fetch(spec.url, { signal: AbortSignal.timeout(60_000), headers: { "User-Agent": "Self Host Layer Email (Shield)" } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          let body = Buffer.from(await res.arrayBuffer());
          if (spec.gzip) body = gunzipSync(body);
          const text = body.toString("utf8");
          // A truncated or empty answer must not wipe a good list.
          if (text.split("\n").length < 100) throw new Error("the download was nearly empty");
          const tmp = `${this.#file(name)}.tmp`;
          writeFileSync(tmp, text);
          renameSync(tmp, this.#file(name));
          this.#load(name);
          this.#errors.delete(name);
        } catch (err) {
          this.#errors.set(name, (err as Error).message);
          console.error(`Shield: downloading ${name} failed: ${(err as Error).message}`);
        }
      }
    })().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  lists(): ListStatus[] {
    return Object.keys(LISTS).map((name) => ({
      name,
      entries: name === "datacenters" ? this.#datacenters.size : name in this.#domains ? this.#domains[name as "disposable"].size : this.#ips[name as "spamIps"].size,
      updatedAt: this.#age(name),
      error: this.#errors.get(name) ?? null,
    }));
  }

  // The checks

  /** The domain has somewhere to deliver: MX records (not a null MX), else an A or AAAA record. null: DNS didn't answer, so nobody is refused for it. */
  async #delivers(domain: string): Promise<{ ok: boolean | null; detail: string }> {
    const hit = this.#mx.get(domain);
    if (hit && Date.now() - hit.at < (hit.ok === false ? MX_FAIL_TTL : MX_TTL)) return hit;
    const done = (ok: boolean | null, detail: string) => {
      if (this.#mx.size > 50_000) this.#mx.clear();
      const r = { ok, detail, at: Date.now() };
      this.#mx.set(domain, r);
      return r;
    };
    const gone = (err: unknown) => ["ENOTFOUND", "ENODATA", "NXDOMAIN"].includes((err as { code?: string }).code ?? "");
    try {
      const mx = await this.#dns.resolveMx(domain);
      if (mx.length === 1 && (mx[0]!.exchange === "" || mx[0]!.exchange === ".")) return done(false, `${domain} says it takes no email`);
      if (mx.length) return done(true, "");
    } catch (err) {
      if (!gone(err)) return done(null, "");
    }
    for (const lookup of [(d: string) => this.#dns.resolve4(d), (d: string) => this.#dns.resolve6(d)]) {
      try {
        if ((await lookup(domain)).length) return done(true, "");
      } catch (err) {
        if (!gone(err)) return done(null, "");
      }
    }
    return done(false, `no mail server for ${domain}`);
  }

  /** The address checks, for every check not set to off (all of them with `all`, for Clean the list's counts). */
  async checkAddress(brandId: number, email: string, settings = this.settings(brandId), all = false): Promise<Verdict[]> {
    const on = (c: Check) => all || settings.checks[c] !== "off";
    const out: Verdict[] = [];
    const at = email.lastIndexOf("@");
    const domain = email.slice(at + 1).toLowerCase();
    if (on("invalid")) {
      if (at < 1 || !/^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(email) || /\.\.|^\.|\.@/.test(email)) out.push({ check: "invalid", detail: "not an email address" });
      else {
        const d = await this.#delivers(domain);
        if (d.ok === false) out.push({ check: "invalid", detail: d.detail });
      }
    }
    if (on("disposable") && domainIn(this.#domains.disposable, domain)) out.push({ check: "disposable", detail: `${domain} is a throwaway inbox` });
    if (on("spamDomain") && domainIn(this.#domains.toxicDomains, domain)) out.push({ check: "spamDomain", detail: `${domain} is listed by StopForumSpam` });
    if (on("freeMail") && FREE_MAIL.has(domain)) out.push({ check: "freeMail", detail: `${domain} is free webmail` });
    if (on("bounced")) {
      const elsewhere = this.#db
        .prepare("SELECT 1 FROM suppressions WHERE email = ? AND brand_id != ? AND reason IN ('bounce', 'complaint') UNION SELECT 1 FROM contacts WHERE email = ? AND brand_id != ? AND status IN ('bounced', 'complained') LIMIT 1")
        .get(email, brandId, email, brandId);
      if (elsewhere) out.push({ check: "bounced", detail: "bounced or complained with another brand here" });
    }
    return out;
  }

  /** AbuseIPDB's confidence that the address is abusive (0-100), cached a day; null without a key or an answer. */
  async #abuseScore(ip: string): Promise<number | null> {
    const sealed = getSetting(this.#db, "abuseipdbKey");
    if (!sealed) return null;
    const hit = this.#abuse.get(ip);
    if (hit && Date.now() - hit.at < DAY) return hit.score;
    try {
      const res = await this.#fetch(`https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`, {
        headers: { Key: this.#secrets.open(sealed), Accept: "application/json" },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return null;
      const score = Number(((await res.json()) as { data?: { abuseConfidenceScore?: number } }).data?.abuseConfidenceScore);
      if (!Number.isFinite(score)) return null;
      if (this.#abuse.size > 20_000) this.#abuse.clear();
      this.#abuse.set(ip, { score, at: Date.now() });
      return score;
    } catch {
      return null;
    }
  }

  /** A sign-up from a browser: the address checks, then what the request says about who sent it. */
  async checkSignup(brandId: number, s: SignupInput, settings = this.settings(brandId)): Promise<Verdict[]> {
    const out = await this.checkAddress(brandId, s.email, settings);
    const on = (c: Check) => settings.checks[c] !== "off";
    if (on("scripted")) {
      const ua = s.userAgent ?? "";
      if (!ua.trim()) out.push({ check: "scripted", detail: "no browser named itself" });
      else if (SCRIPTED_UA.test(ua)) out.push({ check: "scripted", detail: `sent by ${(SCRIPTED_UA.exec(ua)?.[0] ?? "a script").replace(/\/$/, "")}` });
      else if (s.honeypot) out.push({ check: "scripted", detail: "the hidden field was filled in" });
      else if (s.webdriver) out.push({ check: "scripted", detail: "the browser is driven by a script" });
      else if (s.elapsedMs !== undefined && s.elapsedMs >= 0 && s.elapsedMs < 2000) out.push({ check: "scripted", detail: `the form was sent ${(s.elapsedMs / 1000).toFixed(1)}s after it loaded` });
    }
    const ip = s.ip ?? "";
    if (ip && (isIPv4(ip) || isIPv6(ip))) {
      if (on("spamIp") && this.#ips.spamIps.has(ip)) out.push({ check: "spamIp", detail: "the IP is listed by StopForumSpam" });
      if (on("abusiveIp")) {
        if (this.#ips.torExits.has(ip)) out.push({ check: "abusiveIp", detail: "a Tor exit node" });
        else if (!settings.allowDatacenter && this.#datacenters.has(ip)) out.push({ check: "abusiveIp", detail: "a data center, not a home or office" });
        else {
          const score = await this.#abuseScore(ip);
          if (score !== null && score >= 75) out.push({ check: "abusiveIp", detail: `reported on AbuseIPDB (${score}% confidence)` });
        }
      }
    }
    return out;
  }

  /** What was refused or flagged, by check, for the Shield page: never the address. */
  log(brandId: number, outcome: Decision["outcome"], checks: string[], source: string, country: string | null = null, n = 1): void {
    if (outcome === "ok" || n < 1) return;
    this.#db.prepare("INSERT INTO shield_log (brand_id, at, outcome, checks, source, country, n) VALUES (?, ?, ?, ?, ?, ?, ?)").run(brandId, Date.now(), outcome === "refuse" ? "refused" : "flagged", checks.join(","), source, country, n);
  }

  /** A batch's verdicts in the log: one row per outcome and set of checks, with how many (an import of millions doesn't write millions of rows). */
  logBatch(brandId: number, verdicts: Verdicts, source: string): void {
    const groups = new Map<string, { outcome: Decision["outcome"]; checks: string[]; n: number }>();
    for (const v of verdicts.values()) {
      if (v.outcome === "ok") continue;
      const key = `${v.outcome}|${v.checks.join(",")}`;
      const g = groups.get(key) ?? { outcome: v.outcome, checks: v.checks, n: 0 };
      g.n++;
      groups.set(key, g);
    }
    for (const g of groups.values()) this.log(brandId, g.outcome, g.checks, source, null, g.n);
  }

  /** Verdicts for many addresses (an import, a sync), and what they come to: counts by check, with a few examples. */
  async verdicts(brandId: number, emails: string[]): Promise<{ verdicts: Verdicts; summary: VerdictSummary }> {
    const settings = this.settings(brandId);
    const found = await this.checkMany(brandId, emails);
    const verdicts: Verdicts = new Map();
    const summary: VerdictSummary = { total: found.size, ok: 0, flag: 0, refuse: 0, byCheck: {}, examples: {} };
    for (const [email, v] of found) {
      const d = decide(v, settings);
      verdicts.set(email, { outcome: d.outcome, checks: d.verdicts.map((x) => x.check), labels: d.verdicts.map((x) => CHECK_LABELS[x.check]) });
      summary[d.outcome]++;
      for (const x of d.verdicts) {
        const b = (summary.byCheck[x.check] ??= { action: x.action, count: 0 });
        b.count++;
        const ex = (summary.examples[x.check] ??= []);
        if (ex.length < 5) ex.push({ email, detail: x.detail });
      }
    }
    return { verdicts, summary };
  }

  /** Refusals and flags in the last `days`, by check and by source. */
  stats(brandId: number, days = 30): { refused: number; flagged: number; byCheck: Record<string, { refused: number; flagged: number }>; bySource: Record<string, number> } {
    const rows = this.#db.prepare("SELECT outcome, checks, source, sum(n) n FROM shield_log WHERE brand_id = ? AND at >= ? GROUP BY outcome, checks, source").all(brandId, Date.now() - days * DAY) as { outcome: "refused" | "flagged"; checks: string; source: string; n: number }[];
    const out = { refused: 0, flagged: 0, byCheck: {} as Record<string, { refused: number; flagged: number }>, bySource: {} as Record<string, number> };
    for (const r of rows) {
      out[r.outcome] += r.n;
      out.bySource[r.source] = (out.bySource[r.source] ?? 0) + r.n;
      for (const c of r.checks.split(",")) {
        const b = (out.byCheck[c] ??= { refused: 0, flagged: 0 });
        b[r.outcome] += r.n;
      }
    }
    return out;
  }

  /** Many addresses at once (an import, a sync, Clean the list), 20 DNS lookups at a time. */
  async checkMany(brandId: number, emails: string[], o: { all?: boolean } = {}): Promise<Map<string, Verdict[]>> {
    const settings = this.settings(brandId);
    const out = new Map<string, Verdict[]>();
    const unique = [...new Set(emails.map((e) => e.toLowerCase()))];
    let next = 0;
    const worker = async () => {
      while (next < unique.length) {
        const email = unique[next++]!;
        out.set(email, await this.checkAddress(brandId, email, settings, o.all));
      }
    };
    await Promise.all(Array.from({ length: Math.min(20, unique.length) }, worker));
    return out;
  }
}

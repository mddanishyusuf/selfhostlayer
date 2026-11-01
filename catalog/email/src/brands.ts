// Brands: each product on the install, with its sender defaults (from, reply
// to, the postal address the footer of every campaign must carry), how fast it
// may send, whether opens and clicks are tracked, and its provider: SMTP (host,
// port, security, username; the password encrypted) or Amazon SES (region,
// access key; the secret key encrypted). Each brand's sender is made once and
// kept until its provider changes.
import type { DatabaseSync } from "node:sqlite";
import { InputError } from "../../lib/http.ts";
import { tx } from "./db.ts";
import { isEmail } from "./mime.ts";
import { SendError, SesSender, SmtpSender, type DkimKeyFor, type Sender } from "./providers.ts";
import type { Secrets } from "../../lib/secrets.ts";
import { Ses } from "./ses.ts";
import type { SmtpConfig } from "./smtp.ts";

export type ProviderKind = "none" | "smtp" | "ses";

export interface Brand {
  id: number;
  name: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  address: string;
  website: string;
  provider: ProviderKind;
  smtp: { host: string; port: number; security: "tls" | "starttls" | "none"; username: string; hasPassword: boolean } | null;
  ses: { region: string; accessKeyId: string; hasSecret: boolean; events: { configurationSet: string; topicArn: string } | null } | null;
  /** Emails per second, at most. */
  rate: number;
  trackOpens: boolean;
  trackClicks: boolean;
  createdAt: number;
}

interface Row {
  id: number;
  name: string;
  from_name: string;
  from_email: string;
  reply_to: string;
  address: string;
  website: string;
  provider: ProviderKind;
  provider_config: string;
  provider_secret: string | null;
  rate: number;
  track_opens: number;
  track_clicks: number;
  ses_events: string | null;
  created_at: number;
}

/** What else the brands need: secrets, how to reach the outside, the DKIM keys, this install's name. */
export interface BrandsEnv {
  db: DatabaseSync;
  secrets: Secrets;
  dkim: (brandId: number) => DkimKeyFor;
  hostName: () => string;
  fetch?: typeof fetch;
  awsEndpoint?: string;
  smtpCa?: string;
}

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$|^\d{1,3}(?:\.\d{1,3}){3}$/i;

export function text(value: unknown, field: string, max: number, o: { required?: boolean } = {}): string {
  if (value === undefined || value === null) {
    if (o.required) throw new InputError(field, "is required");
    return "";
  }
  if (typeof value !== "string") throw new InputError(field, "must be text");
  const t = value.trim();
  if (o.required && !t) throw new InputError(field, "is required");
  if (t.length > max) throw new InputError(field, `must be at most ${max} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t)) throw new InputError(field, "has characters that can't be in it");
  return t;
}

const oneLine = (value: unknown, field: string, max: number, o: { required?: boolean } = {}) => {
  const t = text(value, field, max, o);
  if (/[\r\n]/.test(t)) throw new InputError(field, "must be one line");
  return t;
};

export class Brands {
  readonly #env: BrandsEnv;
  readonly #senders = new Map<number, Sender>();

  constructor(env: BrandsEnv) {
    this.#env = env;
  }

  #row(id: number): Row | undefined {
    return this.#env.db.prepare("SELECT * FROM brands WHERE id = ?").get(id) as unknown as Row | undefined;
  }

  #from(r: Row): Brand {
    const cfg = JSON.parse(r.provider_config) as Record<string, unknown>;
    return {
      id: r.id,
      name: r.name,
      fromName: r.from_name,
      fromEmail: r.from_email,
      replyTo: r.reply_to,
      address: r.address,
      website: r.website,
      provider: r.provider,
      smtp:
        r.provider === "smtp"
          ? { host: String(cfg.host), port: Number(cfg.port), security: cfg.security as "tls" | "starttls" | "none", username: String(cfg.username ?? ""), hasPassword: r.provider_secret !== null }
          : null,
      ses: r.provider === "ses" ? { region: String(cfg.region), accessKeyId: String(cfg.accessKeyId), hasSecret: r.provider_secret !== null, events: r.ses_events ? JSON.parse(r.ses_events) : null } : null,
      rate: r.rate,
      trackOpens: r.track_opens === 1,
      trackClicks: r.track_clicks === 1,
      createdAt: r.created_at,
    };
  }

  list(): Brand[] {
    return (this.#env.db.prepare("SELECT * FROM brands ORDER BY name COLLATE NOCASE").all() as unknown as Row[]).map((r) => this.#from(r));
  }

  get(id: number): Brand | null {
    const r = this.#row(id);
    return r ? this.#from(r) : null;
  }

  /** The brand, or a 404 for the API. */
  must(id: number): Brand {
    const b = Number.isInteger(id) ? this.get(id) : null;
    if (!b) throw new InputError("brand", "no such brand", 404);
    return b;
  }

  #fields(input: Record<string, unknown>, was?: Brand) {
    const fromEmail = input.fromEmail === undefined ? (was?.fromEmail ?? "") : oneLine(input.fromEmail, "fromEmail", 254);
    if (fromEmail && !isEmail(fromEmail)) throw new InputError("fromEmail", "must be an email address");
    const replyTo = input.replyTo === undefined ? (was?.replyTo ?? "") : oneLine(input.replyTo, "replyTo", 254);
    if (replyTo && !isEmail(replyTo)) throw new InputError("replyTo", "must be an email address");
    const website = input.website === undefined ? (was?.website ?? "") : oneLine(input.website, "website", 300);
    if (website && !/^https?:\/\/\S+$/.test(website)) throw new InputError("website", "must start with https://");
    const rate = input.rate === undefined ? (was?.rate ?? 5) : Number(input.rate);
    if (!Number.isFinite(rate) || rate < 0.1 || rate > 500) throw new InputError("rate", "must be 0.1 to 500 emails a second");
    return {
      name: input.name === undefined && was ? was.name : oneLine(input.name, "name", 80, { required: true }),
      fromName: input.fromName === undefined ? (was?.fromName ?? "") : oneLine(input.fromName, "fromName", 120),
      fromEmail,
      replyTo,
      address: input.address === undefined ? (was?.address ?? "") : text(input.address, "address", 400),
      website,
      rate,
      trackOpens: input.trackOpens === undefined ? (was?.trackOpens ?? true) : input.trackOpens === true,
      trackClicks: input.trackClicks === undefined ? (was?.trackClicks ?? true) : input.trackClicks === true,
    };
  }

  add(input: Record<string, unknown>): Brand {
    const f = this.#fields(input);
    if ((this.#env.db.prepare("SELECT count(*) n FROM brands").get() as { n: number }).n >= 100) throw new InputError("name", "at most 100 brands", 409);
    const id = Number(
      this.#env.db
        .prepare("INSERT INTO brands (name, from_name, from_email, reply_to, address, website, rate, track_opens, track_clicks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(f.name, f.fromName, f.fromEmail, f.replyTo, f.address, f.website, f.rate, f.trackOpens ? 1 : 0, f.trackClicks ? 1 : 0, Date.now()).lastInsertRowid,
    );
    return this.get(id)!;
  }

  update(id: number, input: Record<string, unknown>): Brand {
    const f = this.#fields(input, this.must(id));
    this.#env.db
      .prepare("UPDATE brands SET name = ?, from_name = ?, from_email = ?, reply_to = ?, address = ?, website = ?, rate = ?, track_opens = ?, track_clicks = ? WHERE id = ?")
      .run(f.name, f.fromName, f.fromEmail, f.replyTo, f.address, f.website, f.rate, f.trackOpens ? 1 : 0, f.trackClicks ? 1 : 0, id);
    return this.get(id)!;
  }

  /** SMTP or SES, checked; a secret left out keeps the one in use. Another kind of provider means the domains are checked again. */
  setProvider(id: number, input: Record<string, unknown>): Brand {
    const was = this.must(id);
    const row = this.#row(id)!;
    const kind = input.provider;
    let config: Record<string, unknown>;
    let secret: string | null;
    let sesMoved = false;
    if (kind === "smtp") {
      const host = oneLine(input.host, "host", 253, { required: true }).toLowerCase();
      if (!HOST.test(host)) throw new InputError("host", "must be a host name like smtp.example.com");
      const port = Number(input.port ?? 587);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InputError("port", "must be a port, like 587");
      const security = input.security ?? (port === 465 ? "tls" : "starttls");
      if (security !== "tls" && security !== "starttls" && security !== "none") throw new InputError("security", "must be tls, starttls or none");
      const username = oneLine(input.username, "username", 200);
      const password = input.password === undefined || input.password === "" ? null : oneLine(input.password, "password", 500);
      config = { host, port, security, username };
      secret = password !== null ? this.#env.secrets.seal(password) : was.provider === "smtp" ? row.provider_secret : null;
    } else if (kind === "ses") {
      const region = oneLine(input.region, "region", 30, { required: true });
      if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new InputError("region", "must be an AWS region like us-east-1");
      const accessKeyId = oneLine(input.accessKeyId, "accessKeyId", 128, { required: true });
      if (!/^[A-Z0-9]{16,128}$/.test(accessKeyId)) throw new InputError("accessKeyId", "must be an AWS access key id (AKIA…)");
      const key = input.secretAccessKey === undefined || input.secretAccessKey === "" ? null : oneLine(input.secretAccessKey, "secretAccessKey", 128);
      config = { region, accessKeyId };
      secret = key !== null ? this.#env.secrets.seal(key) : was.provider === "ses" && was.ses?.accessKeyId === accessKeyId ? row.provider_secret : null;
      if (secret === null) throw new InputError("secretAccessKey", "is required");
      // Another region or AWS account has none of the old one's identities, DKIM tokens or event topic.
      sesMoved = was.provider !== "ses" || was.ses?.region !== region || was.ses?.accessKeyId !== accessKeyId;
    } else if (kind === "none") {
      config = {};
      secret = null;
    } else throw new InputError("provider", "must be smtp, ses or none");
    tx(this.#env.db, () => {
      this.#env.db.prepare("UPDATE brands SET provider = ?, provider_config = ?, provider_secret = ?, ses_events = CASE WHEN ? THEN ses_events ELSE NULL END WHERE id = ?").run(kind, JSON.stringify(config), secret, kind === "ses" && !sesMoved ? 1 : 0, id);
      // Checked again; there, the next check makes each domain's identity in SES.
      if (sesMoved) this.#env.db.prepare("UPDATE domains SET status = 'pending', verified_at = NULL, ses_tokens = NULL WHERE brand_id = ?").run(id);
      else if (kind !== was.provider) this.#env.db.prepare("UPDATE domains SET status = 'pending', verified_at = NULL WHERE brand_id = ?").run(id);
    });
    void this.#senders.get(id)?.close();
    this.#senders.delete(id);
    return this.get(id)!;
  }

  setSesEvents(id: number, events: { configurationSet: string; topicArn: string }): void {
    this.#env.db.prepare("UPDATE brands SET ses_events = ? WHERE id = ?").run(JSON.stringify(events), id);
  }

  /** The topics bounces and complaints may come from, for checking SNS messages. */
  sesTopics(): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.#env.db.prepare("SELECT id, ses_events FROM brands WHERE ses_events IS NOT NULL").all() as { id: number; ses_events: string }[]) {
      out.set((JSON.parse(r.ses_events) as { topicArn: string }).topicArn, r.id);
    }
    return out;
  }

  #secret(id: number): string {
    const sealed = this.#row(id)?.provider_secret;
    if (!sealed) throw new SendError("the provider's password or secret key isn't set", true);
    return this.#env.secrets.open(sealed);
  }

  /** The brand's SES client (SES brands only). */
  ses(id: number): Ses {
    const b = this.must(id);
    if (b.provider !== "ses" || !b.ses) throw new InputError("provider", "this brand doesn't send with Amazon SES", 409);
    return new Ses({ region: b.ses.region, accessKeyId: b.ses.accessKeyId, secretAccessKey: this.#secret(id) }, { fetch: this.#env.fetch, endpoint: this.#env.awsEndpoint });
  }

  /** The brand's SMTP settings with its password (SMTP brands only). */
  smtpConfig(id: number): SmtpConfig {
    const b = this.must(id);
    if (b.provider !== "smtp" || !b.smtp) throw new InputError("provider", "this brand doesn't send over SMTP", 409);
    return { host: b.smtp.host, port: b.smtp.port, security: b.smtp.security, username: b.smtp.username || undefined, password: b.smtp.username ? this.#secret(id) : undefined };
  }

  /** How the brand sends, made once and kept. */
  sender(id: number): Sender {
    const cached = this.#senders.get(id);
    if (cached) return cached;
    const b = this.must(id);
    let s: Sender;
    if (b.provider === "smtp" && b.smtp) {
      s = new SmtpSender(this.smtpConfig(id), { dkim: this.#env.dkim(id), name: this.#env.hostName, ca: this.#env.smtpCa });
    } else if (b.provider === "ses" && b.ses) {
      s = new SesSender({ region: b.ses.region, accessKeyId: b.ses.accessKeyId, secretAccessKey: this.#secret(id) }, { configurationSet: () => this.get(id)?.ses?.events?.configurationSet ?? null, fetch: this.#env.fetch, endpoint: this.#env.awsEndpoint });
    } else throw new SendError("this brand has no provider yet: set SMTP or Amazon SES in its settings", true);
    this.#senders.set(id, s);
    return s;
  }

  /** Deletes the brand and everything it has. */
  remove(id: number): void {
    this.must(id);
    const db = this.#env.db;
    tx(db, () => {
      db.prepare("DELETE FROM message_bodies WHERE message_id IN (SELECT id FROM messages WHERE brand_id = ?)").run(id);
      db.prepare("DELETE FROM events WHERE message_id IN (SELECT id FROM messages WHERE brand_id = ?)").run(id);
      db.prepare("DELETE FROM list_members WHERE list_id IN (SELECT id FROM lists WHERE brand_id = ?)").run(id);
      db.prepare("DELETE FROM automation_runs WHERE automation_id IN (SELECT id FROM automations WHERE brand_id = ?)").run(id);
      db.prepare("DELETE FROM idempotency WHERE key_id IN (SELECT id FROM api_keys WHERE brand_id = ?)").run(id);
      for (const table of ["messages", "contacts", "lists", "suppressions", "templates", "campaigns", "automations", "api_keys", "domains"]) db.prepare(`DELETE FROM ${table} WHERE brand_id = ?`).run(id);
      db.prepare("DELETE FROM brands WHERE id = ?").run(id);
    });
    void this.#senders.get(id)?.close();
    this.#senders.delete(id);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#senders.values()].map((s) => s.close()));
    this.#senders.clear();
  }
}

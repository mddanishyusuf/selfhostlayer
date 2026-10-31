// Sending through a brand's provider: an SMTP connection kept open while
// mail keeps coming (closed after 30 seconds idle), or SES's API. Mail over
// SMTP is signed with the From domain's DKIM key; SES signs its own.
import { dkimSign } from "./dkim.ts";
import { AwsError, Ses, type AwsCredentials } from "./ses.ts";
import { SmtpConnection, SmtpError, type SmtpConfig } from "./smtp.ts";

export interface Outgoing {
  /** The envelope sender, and the domain whose DKIM key signs. */
  from: string;
  fromDomain: string;
  to: string[];
  raw: Buffer;
}

export interface Sent {
  providerId: string | null;
  /** Recipients the server refused while taking the rest, and why (SMTP). */
  refused: { to: string; reason: string; permanent: boolean }[];
}

export class SendError extends Error {
  /** Trying again won't help (a 5xx, a message SES rejects). */
  readonly permanent: boolean;
  /** The recipient doesn't exist or refuses mail: a hard bounce. */
  readonly bounce: boolean;
  constructor(message: string, permanent: boolean, bounce = false) {
    super(message);
    this.permanent = permanent;
    this.bounce = bounce;
  }
}

export interface Sender {
  send(m: Outgoing): Promise<Sent>;
  close(): Promise<void>;
}

export type DkimKeyFor = (domain: string) => { selector: string; privateKey: string } | null;

const IDLE = 30_000;

export class SmtpSender implements Sender {
  readonly #cfg: SmtpConfig;
  readonly #dkim: DkimKeyFor;
  readonly #name: () => string;
  readonly #ca?: string;
  #conn: Promise<SmtpConnection> | null = null;
  #idle: NodeJS.Timeout | null = null;
  #busy: Promise<unknown> = Promise.resolve();

  /** name: what to say in EHLO (this install's own host name). ca: a certificate to trust (tests). */
  constructor(cfg: SmtpConfig, o: { dkim: DkimKeyFor; name: () => string; ca?: string }) {
    this.#cfg = cfg;
    this.#dkim = o.dkim;
    this.#name = o.name;
    this.#ca = o.ca;
  }

  #connection(): Promise<SmtpConnection> {
    if (!this.#conn) {
      this.#conn = SmtpConnection.open(this.#cfg, { name: this.#name(), ca: this.#ca });
      this.#conn.catch(() => (this.#conn = null));
    }
    return this.#conn;
  }

  #drop(): void {
    const c = this.#conn;
    this.#conn = null;
    void c?.then((x) => x.close()).catch(() => {});
  }

  /** One message at a time on the connection. */
  send(m: Outgoing): Promise<Sent> {
    const run = this.#busy.then(() => this.#send(m));
    this.#busy = run.catch(() => {});
    return run;
  }

  async #send(m: Outgoing): Promise<Sent> {
    if (this.#idle) clearTimeout(this.#idle);
    const key = this.#dkim(m.fromDomain);
    const raw = key ? dkimSign(m.raw, { domain: m.fromDomain, selector: key.selector, privateKey: key.privateKey }) : m.raw;
    // A kept connection may have been closed by the server meanwhile: one more try on a fresh one.
    for (let attempt = 0; ; attempt++) {
      let c: SmtpConnection;
      try {
        c = await this.#connection();
        if (c.closed) throw new SmtpError("closed");
      } catch (err) {
        this.#conn = null;
        const e = err as SmtpError;
        if (attempt === 0 && !e.code && e.message === "closed") continue;
        throw new SendError(e.message, e.permanent);
      }
      try {
        const r = await c.send({ from: m.from, to: m.to }, raw);
        this.#idle = setTimeout(() => this.#drop(), IDLE);
        this.#idle.unref();
        return {
          providerId: /\b(?:queued as|id=|Ok:? queued as)\s*<?([\w.@-]+)>?/i.exec(r.response)?.[1] ?? null,
          refused: r.refused.map((x) => ({ to: x.to, reason: x.error.message, permanent: x.error.permanent })),
        };
      } catch (err) {
        this.#drop();
        const e = err as SmtpError;
        if (attempt === 0 && !e.code) continue;
        throw new SendError(e.message, e.permanent, e.permanent && /RCPT TO/.test(e.message) && [550, 551, 553].includes(e.code));
      }
    }
  }

  async close(): Promise<void> {
    if (this.#idle) clearTimeout(this.#idle);
    this.#drop();
  }
}

export class SesSender implements Sender {
  readonly #ses: Ses;
  readonly #configurationSet: () => string | null;

  constructor(c: AwsCredentials, o: { configurationSet: () => string | null; fetch?: typeof fetch; endpoint?: string }) {
    this.#ses = new Ses(c, { fetch: o.fetch, endpoint: o.endpoint });
    this.#configurationSet = o.configurationSet;
  }

  get ses(): Ses {
    return this.#ses;
  }

  async send(m: Outgoing): Promise<Sent> {
    try {
      return { providerId: await this.#ses.sendRaw({ from: m.from, to: m.to, raw: m.raw, configurationSet: this.#configurationSet() }), refused: [] };
    } catch (err) {
      if (err instanceof AwsError) throw new SendError(err.message, !err.transient);
      throw new SendError((err as Error).message, false);
    }
  }

  async close(): Promise<void> {}
}

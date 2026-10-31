// An SMTP client (RFC 5321) for sending through any provider: implicit TLS
// (465), STARTTLS (587, required once offered: never send credentials in the
// clear unless security is "none"), AUTH PLAIN or LOGIN, then MAIL, RCPT and
// DATA. One connection sends many messages (RSET between them). A 5xx reply is
// permanent (a bounce when it's for a recipient); 4xx, timeouts and dropped
// connections are worth another try.
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

export interface SmtpConfig {
  host: string;
  port: number;
  /** "tls": TLS from the start (465); "starttls": upgrade after EHLO (587); "none": plain (25, local relays). */
  security: "tls" | "starttls" | "none";
  username?: string;
  password?: string;
}

export class SmtpError extends Error {
  readonly code: number;
  /** A 5xx reply: trying again won't help. */
  readonly permanent: boolean;
  constructor(message: string, code = 0, permanent = false) {
    super(message);
    this.code = code;
    this.permanent = permanent;
  }
}

interface Reply {
  code: number;
  lines: string[];
}

const TIMEOUT = 60_000;

export class SmtpConnection {
  #socket: Socket | TLSSocket;
  #buffer = "";
  #waiting: ((r: Reply | Error) => void) | null = null;
  #pending: Reply[] = [];
  #lines: string[] = [];
  #closed = false;
  #ca?: string;
  extensions = new Set<string>();
  auth = new Set<string>();

  private constructor(socket: Socket | TLSSocket, ca?: string) {
    this.#socket = socket;
    this.#ca = ca;
    this.#listen(socket);
  }

  #listen(socket: Socket | TLSSocket): void {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let at: number;
      while ((at = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, at).replace(/\r$/, "");
        this.#buffer = this.#buffer.slice(at + 1);
        this.#lines.push(line.slice(4));
        // "250-…" continues a reply; "250 …" ends it.
        if (line[3] !== "-") {
          const reply = { code: Number(line.slice(0, 3)) || 0, lines: this.#lines };
          this.#lines = [];
          if (this.#waiting) {
            const w = this.#waiting;
            this.#waiting = null;
            w(reply);
          } else this.#pending.push(reply);
        }
      }
    });
    const fail = (err: Error) => {
      this.#closed = true;
      if (this.#waiting) {
        const w = this.#waiting;
        this.#waiting = null;
        w(err);
      }
    };
    socket.on("error", (err) => fail(new SmtpError(`the connection failed: ${err.message}`)));
    socket.on("close", () => fail(new SmtpError("the server closed the connection")));
  }

  #read(timeout = TIMEOUT): Promise<Reply> {
    const ready = this.#pending.shift();
    if (ready) return Promise.resolve(ready);
    if (this.#closed) return Promise.reject(new SmtpError("the connection is closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting = null;
        this.#socket.destroy();
        reject(new SmtpError(`the server didn't answer within ${timeout / 1000}s`));
      }, timeout);
      this.#waiting = (r) => {
        clearTimeout(timer);
        if (r instanceof Error) reject(r);
        else resolve(r);
      };
    });
  }

  async #command(line: string, expect: number[], what = line.split(" ")[0]!, timeout?: number): Promise<Reply> {
    this.#socket.write(`${line}\r\n`);
    const r = await this.#read(timeout);
    if (!expect.includes(r.code)) throw new SmtpError(`${what}: ${r.code} ${r.lines.join(" ")}`.slice(0, 500), r.code, r.code >= 500);
    return r;
  }

  async #ehlo(name: string): Promise<void> {
    let r: Reply;
    try {
      r = await this.#command(`EHLO ${name}`, [250]);
    } catch (err) {
      if (!(err instanceof SmtpError) || !err.code) throw err;
      r = await this.#command(`HELO ${name}`, [250]);
    }
    this.extensions = new Set(r.lines.slice(1).map((l) => l.split(" ")[0]!.toUpperCase()));
    const auth = r.lines.find((l) => /^AUTH[ =]/i.test(l));
    this.auth = new Set(auth ? auth.slice(5).toUpperCase().split(/\s+/) : []);
  }

  /** Connects, greets, upgrades to TLS when asked, and logs in when there's a username. */
  static async open(cfg: SmtpConfig, o: { name: string; ca?: string; timeout?: number } = { name: "localhost" }): Promise<SmtpConnection> {
    const socket = await new Promise<Socket | TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        s.destroy();
        reject(new SmtpError(`couldn't connect to ${cfg.host}:${cfg.port} within ${(o.timeout ?? 20_000) / 1000}s`));
      }, o.timeout ?? 20_000);
      const done = () => {
        clearTimeout(timer);
        resolve(s);
      };
      const s: Socket | TLSSocket =
        cfg.security === "tls" ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host, ca: o.ca }, done) : netConnect({ host: cfg.host, port: cfg.port }, done);
      s.once("error", (err) => {
        clearTimeout(timer);
        reject(new SmtpError(`couldn't connect to ${cfg.host}:${cfg.port}: ${err.message}`));
      });
    });
    const c = new SmtpConnection(socket, o.ca);
    try {
      const greeting = await c.#read();
      if (greeting.code !== 220) throw new SmtpError(`the server's greeting: ${greeting.code} ${greeting.lines.join(" ")}`, greeting.code, greeting.code >= 500);
      await c.#ehlo(o.name);
      if (cfg.security === "starttls") {
        if (!c.extensions.has("STARTTLS")) throw new SmtpError(`${cfg.host} doesn't offer STARTTLS: use TLS (port 465), or "none" for a relay on this server`, 0, true);
        await c.#command("STARTTLS", [220]);
        await c.#upgrade(cfg.host);
        await c.#ehlo(o.name);
      }
      if (cfg.username) {
        const user = cfg.username;
        const pass = cfg.password ?? "";
        if (c.auth.has("PLAIN") || !c.auth.has("LOGIN")) {
          await c.#command(`AUTH PLAIN ${Buffer.from(`\u0000${user}\u0000${pass}`).toString("base64")}`, [235], "AUTH");
        } else {
          await c.#command("AUTH LOGIN", [334], "AUTH");
          await c.#command(Buffer.from(user).toString("base64"), [334], "AUTH (username)");
          await c.#command(Buffer.from(pass).toString("base64"), [235], "AUTH (password)");
        }
      }
      return c;
    } catch (err) {
      c.#socket.destroy();
      throw err;
    }
  }

  #upgrade(host: string): Promise<void> {
    const plain = this.#socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    return new Promise((resolve, reject) => {
      const secure = tlsConnect({ socket: plain as Socket, servername: host, ca: this.#ca }, () => resolve());
      secure.once("error", (err) => reject(new SmtpError(`TLS with ${host} failed: ${err.message}`)));
      this.#socket = secure;
      this.#listen(secure);
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Sends one message. Recipients the server refuses are returned with why;
   * when it refuses all of them, or the message, this throws.
   */
  async send(envelope: { from: string; to: string[] }, data: Buffer): Promise<{ response: string; refused: { to: string; error: SmtpError }[] }> {
    await this.#command(`MAIL FROM:<${envelope.from}>`, [250], "MAIL FROM");
    const refused: { to: string; error: SmtpError }[] = [];
    for (const to of envelope.to) {
      try {
        await this.#command(`RCPT TO:<${to}>`, [250, 251], `RCPT TO ${to}`);
      } catch (err) {
        if (!(err instanceof SmtpError) || !err.code) throw err;
        refused.push({ to, error: err });
      }
    }
    if (refused.length === envelope.to.length) {
      await this.#command("RSET", [250]).catch(() => {});
      const first = refused[0]!.error;
      throw new SmtpError(first.message, first.code, first.permanent);
    }
    await this.#command("DATA", [354]);
    // Dot-stuffing: a line starting with "." gets another.
    const text = data.toString("latin1").replace(/\r?\n/g, "\r\n").replace(/(^|\r\n)\./g, "$1..");
    this.#socket.write(Buffer.from(text.endsWith("\r\n") ? text : `${text}\r\n`, "latin1"));
    const r = await this.#command(".", [250], "the message", 120_000);
    return { response: r.lines.join(" "), refused };
  }

  /** Ready for the next message. */
  async reset(): Promise<void> {
    await this.#command("RSET", [250]);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#command("QUIT", [221], "QUIT", 5000);
    } catch {
      // closing anyway
    }
    this.#socket.destroy();
    this.#closed = true;
  }
}

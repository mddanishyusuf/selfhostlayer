// A small SMTP client for alert emails: implicit TLS (465) or STARTTLS (587),
// AUTH PLAIN or LOGIN, one plain-text message. Works with Resend, Postmark,
// SES, Mailgun, Gmail app passwords and any normal mail server.
import { randomBytes } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { hostname } from "node:os";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

export interface SmtpConfig {
  host: string;
  port: number;
  /** "tls": TLS from the first byte (465). "starttls": upgrade (587). "none": plain, only for a relay on this machine. */
  security: "tls" | "starttls" | "none";
  user?: string;
  pass?: string;
  from: string;
  to: string[];
}

export interface Mail {
  subject: string;
  text: string;
}

const TIMEOUT_MS = 15_000;

/** Reads SMTP replies (multi-line "250-…" until "250 …") from a socket. */
class Replies {
  private buffer = "";
  private waiting: ((reply: { code: number; text: string }) => void) | null = null;
  private failure: ((err: Error) => void) | null = null;
  private socket!: Socket | TLSSocket;

  attach(socket: Socket | TLSSocket): void {
    this.socket = socket;
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.flush();
    });
    socket.on("error", (err) => this.failure?.(err));
    socket.on("close", () => this.failure?.(new Error("the mail server closed the connection")));
  }

  private flush(): void {
    // Keep replies buffered until someone asks for one.
    if (!this.waiting) return;
    const lines = this.buffer.split("\r\n");
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]!) || /^\d{3}$/.test(lines[i]!)) {
        const reply = lines.slice(0, i + 1);
        this.buffer = lines.slice(i + 1).join("\r\n");
        const resolve = this.waiting;
        this.waiting = null;
        this.failure = null;
        resolve?.({ code: Number(reply[i]!.slice(0, 3)), text: reply.map((l) => l.slice(4)).join("\n") });
        return;
      }
    }
  }

  next(): Promise<{ code: number; text: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the mail server didn't answer in time")), TIMEOUT_MS);
      this.waiting = (r) => {
        clearTimeout(timer);
        resolve(r);
      };
      this.failure = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      this.flush();
    });
  }

  async command(line: string | null, expect: number[], what: string): Promise<string> {
    if (line !== null) this.socket.write(line + "\r\n");
    const reply = await this.next();
    if (!expect.includes(reply.code)) throw new Error(`${what}: ${reply.code} ${reply.text.split("\n")[0]}`);
    return reply.text;
  }
}

function open(config: SmtpConfig): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket =
      config.security === "tls"
        ? tlsConnect({ host: config.host, port: config.port, servername: config.host }, () => resolve(socket))
        : netConnect({ host: config.host, port: config.port }, () => resolve(socket));
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error(`couldn't reach ${config.host}:${config.port} (many hosts block outgoing 25 and 465; try 587)`)));
    socket.once("error", reject);
  });
}

/** RFC 2047 for non-ASCII subjects. */
const encodeHeader = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`);

export function buildMessage(config: SmtpConfig, mail: Mail, now = new Date()): string {
  const domain = config.from.split("@")[1] ?? "localhost";
  const body = Buffer.from(mail.text.replace(/\r?\n/g, "\r\n"))
    .toString("base64")
    .replace(/.{76}/g, "$&\r\n");
  return [
    `From: Self Host Layer <${config.from}>`,
    `To: ${config.to.join(", ")}`,
    `Subject: ${encodeHeader(mail.subject.replace(/[\r\n]+/g, " "))}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

export async function sendMail(config: SmtpConfig, mail: Mail): Promise<void> {
  let socket = await open(config);
  const replies = new Replies();
  replies.attach(socket);
  const helo = hostname().replace(/[^A-Za-z0-9.-]/g, "") || "localhost";
  try {
    await replies.command(null, [220], "greeting");
    let features = await replies.command(`EHLO ${helo}`, [250], "EHLO");
    if (config.security === "starttls") {
      if (!/^STARTTLS\b/im.test(features)) throw new Error("the server doesn't offer STARTTLS on this port");
      await replies.command("STARTTLS", [220], "STARTTLS");
      socket.removeAllListeners("data").removeAllListeners("error").removeAllListeners("close");
      socket = await new Promise<TLSSocket>((resolve, reject) => {
        const secure = tlsConnect({ socket, servername: config.host }, () => resolve(secure));
        secure.once("error", reject);
      });
      replies.attach(socket);
      features = await replies.command(`EHLO ${helo}`, [250], "EHLO after STARTTLS");
    }
    if (config.user) {
      const auth = /^AUTH\s+(.+)$/im.exec(features)?.[1]?.toUpperCase().split(/\s+/) ?? [];
      if (auth.includes("PLAIN") || !auth.includes("LOGIN")) {
        await replies.command(`AUTH PLAIN ${Buffer.from(`\0${config.user}\0${config.pass ?? ""}`).toString("base64")}`, [235], "login");
      } else {
        await replies.command("AUTH LOGIN", [334], "login");
        await replies.command(Buffer.from(config.user).toString("base64"), [334], "login");
        await replies.command(Buffer.from(config.pass ?? "").toString("base64"), [235], "login");
      }
    }
    await replies.command(`MAIL FROM:<${config.from}>`, [250], "sender");
    for (const to of config.to) await replies.command(`RCPT TO:<${to}>`, [250, 251], `recipient ${to}`);
    await replies.command("DATA", [354], "DATA");
    // Dot-stuffing: a line starting with "." gets another one.
    const message = buildMessage(config, mail).replace(/^\./gm, "..");
    await replies.command(`${message}\r\n.`, [250], "sending");
    socket.write("QUIT\r\n");
  } finally {
    socket.end();
  }
}

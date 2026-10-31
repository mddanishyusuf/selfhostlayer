// Email messages as RFC 5322 and MIME: addresses, headers (RFC 2047 for
// anything that isn't ASCII, folded under 78 columns), the text and HTML as
// multipart/alternative in quoted-printable, attachments in base64 under
// multipart/mixed, and the List-Unsubscribe headers (RFC 8058's one-click).
// Every line ends in CRLF and stays under 998 characters.
import { randomBytes } from "node:crypto";
import { InputError } from "../../lib/http.ts";

export interface Address {
  name?: string;
  email: string;
}

export interface Attachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface Mail {
  from: Address;
  to: Address[];
  cc?: Address[];
  replyTo?: Address[];
  subject: string;
  html?: string;
  text?: string;
  /** Extra headers (X-Entity-Ref-ID, …); the ones this builder writes can't be set. */
  headers?: Record<string, string>;
  attachments?: Attachment[];
  /** The Message-ID's left part; its domain is the sender's. */
  id: string;
  date?: Date;
  unsubscribe?: { url: string; oneClick: boolean };
}

const EMAIL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,62}$/;

/** An address checked: no spaces, at most 254 characters, a domain with a dot. */
export function isEmail(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value) && value.indexOf("@") <= 64;
}

/** "Name <email>" or "email", as given to the API and the panel; field names the input in errors. */
export function parseAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !value.trim()) throw new InputError(field, "must be an email address");
  const text = value.trim();
  const m = /^(.*?)\s*<([^<>]+)>$/.exec(text);
  const email = (m ? m[2]! : text).trim();
  if (!isEmail(email)) throw new InputError(field, `${email.slice(0, 80)} isn't an email address`);
  let name = m ? m[1]!.trim() : "";
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  if (/[\r\n]/.test(name) || name.length > 200) throw new InputError(field, "has a name that's too long or on several lines");
  return name ? { name, email } : { email };
}

/** One address or a list of them (a string or an array), at most `max`. */
export function parseAddresses(value: unknown, field: string, max = 50): Address[] {
  if (value === undefined || value === null || value === "") return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > max) throw new InputError(field, `at most ${max} addresses`);
  return list.map((v, i) => parseAddress(v, Array.isArray(value) ? `${field}[${i}]` : field));
}

const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** Encoded words (RFC 2047, base64) of at most 75 characters, never splitting a character. */
function encodedWords(text: string): string[] {
  const words: string[] = [];
  let chunk = "";
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString("base64")}?=`);
  return words;
}

/** Text for a header: as it is when it's plain ASCII, else encoded words. */
function headerText(text: string): string {
  return ascii(text) ? text : encodedWords(text).join(" ");
}

export function formatAddress(a: Address): string {
  if (!a.name) return a.email;
  const name = ascii(a.name) ? (/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/.test(a.name) ? a.name : `"${a.name.replace(/(["\\])/g, "\\$1")}"`) : encodedWords(a.name).join(" ");
  return `${name} <${a.email}>`;
}

/** A header line folded at spaces to stay under 78 columns where it can. */
function header(name: string, value: string): string {
  const words = value.split(" ");
  const lines: string[] = [];
  let line = `${name}:`;
  for (const w of words) {
    if (line.length + 1 + w.length > 76 && line.length > name.length + 1) {
      lines.push(line);
      line = "";
    }
    line += ` ${w}`;
  }
  lines.push(line);
  return lines.join("\r\n");
}

/** Quoted-printable (RFC 2045) of UTF-8 text, lines under 76 characters, CRLF line breaks. */
export function quotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n|\r/g, "\n").split("\n")) {
    const bytes = Buffer.from(line, "utf8");
    let encoded = "";
    let current = "";
    bytes.forEach((b, i) => {
      const last = i === bytes.length - 1;
      const piece = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last) ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
      if (current.length + piece.length > 75) {
        encoded += `${current}=\r\n`;
        current = "";
      }
      current += piece;
    });
    out.push(encoded + current);
  }
  return out.join("\r\n");
}

const base64Lines = (data: Buffer) => (data.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");

/** Names this builder writes, which `headers` may not set. */
const RESERVED = new Set(["from", "to", "cc", "bcc", "reply-to", "subject", "date", "message-id", "mime-version", "content-type", "content-transfer-encoding", "list-unsubscribe", "list-unsubscribe-post", "dkim-signature", "sender", "return-path"]);

/** Extra headers checked: names of letters, digits and dashes, one-line values, none this builder writes. */
export function checkHeaders(value: unknown, field = "headers"): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new InputError(field, "must map header names to values");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(k) || RESERVED.has(k.toLowerCase())) throw new InputError(field, `can't set ${k.slice(0, 64)}`);
    if (typeof v !== "string" || /[\r\n]/.test(v) || v.length > 900) throw new InputError(field, `${k} must be one line of text`);
    out[k] = v;
  }
  if (Object.keys(out).length > 20) throw new InputError(field, "at most 20 headers");
  return out;
}

const boundary = () => `=_${randomBytes(12).toString("hex")}`;

/** The date as RFC 5322 writes it, in UTC: Sat, 31 Oct 2026 21:25:21 +0000. */
export function mailDate(d: Date): string {
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${day}, ${p(d.getUTCDate())} ${month} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

export const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/** The whole message, ready for SMTP's DATA or SES's raw content. */
export function buildMessage(m: Mail): Buffer {
  const lines: string[] = [];
  const add = (name: string, value: string) => lines.push(header(name, value));
  add("From", formatAddress(m.from));
  add("To", m.to.length ? m.to.map(formatAddress).join(", ") : "undisclosed-recipients:;");
  if (m.cc?.length) add("Cc", m.cc.map(formatAddress).join(", "));
  if (m.replyTo?.length) add("Reply-To", m.replyTo.map(formatAddress).join(", "));
  add("Subject", headerText(m.subject));
  add("Date", mailDate(m.date ?? new Date()));
  add("Message-ID", `<${m.id}@${domainOf(m.from.email)}>`);
  if (m.unsubscribe) {
    add("List-Unsubscribe", `<${m.unsubscribe.url}>`);
    if (m.unsubscribe.oneClick) add("List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
  }
  for (const [k, v] of Object.entries(m.headers ?? {})) add(k, headerText(v));
  add("MIME-Version", "1.0");

  const textPart = m.text !== undefined && m.text !== "" ? [`Content-Type: text/plain; charset=utf-8`, `Content-Transfer-Encoding: quoted-printable`, "", quotedPrintable(m.text)].join("\r\n") : null;
  const htmlPart = m.html !== undefined && m.html !== "" ? [`Content-Type: text/html; charset=utf-8`, `Content-Transfer-Encoding: quoted-printable`, "", quotedPrintable(m.html)].join("\r\n") : null;
  const parts = [textPart, htmlPart].filter((p): p is string => p !== null);
  if (!parts.length) parts.push([`Content-Type: text/plain; charset=utf-8`, `Content-Transfer-Encoding: quoted-printable`, "", ""].join("\r\n"));

  let body: string;
  if (parts.length === 1) body = parts[0]!;
  else {
    const b = boundary();
    body = [`Content-Type: multipart/alternative; boundary="${b}"`, "", ...parts.flatMap((p) => [`--${b}`, p]), `--${b}--`, ""].join("\r\n");
  }
  if (m.attachments?.length) {
    const b = boundary();
    const files = m.attachments.map((a) => {
      const name = headerText(a.filename).replace(/"/g, "");
      return [`Content-Type: ${a.contentType}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, `Content-Transfer-Encoding: base64`, "", base64Lines(a.content)].join("\r\n");
    });
    body = [`Content-Type: multipart/mixed; boundary="${b}"`, "", `--${b}`, body, ...files.flatMap((f) => [`--${b}`, f]), `--${b}--`, ""].join("\r\n");
  }
  // The top part's Content-Type and encoding are the message's own headers.
  const split = body.indexOf("\r\n\r\n");
  return Buffer.from(`${lines.join("\r\n")}\r\n${body.slice(0, split)}\r\n\r\n${body.slice(split + 4)}`, "utf8");
}

// What a link may be: its slug, where it goes, its redirect type, tags. The
// admin API, the public API and CSV import all check input here.
import { isIP } from "node:net";
import { InputError } from "../../lib/http.ts";

export { InputError };

export const REDIRECTS = [301, 302, 307, 308] as const;
export type Redirect = (typeof REDIRECTS)[number];

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Paths Links answers itself, plus words kept free for later. */
export const RESERVED = new Set(["api", "healthz", "admin", "_admin", "robots.txt", "favicon.ico", "static", "assets"]);
const TAG = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,31}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A slug as stored: lowercase, so Launch and launch are the same link. */
export function checkSlug(value: unknown): string {
  if (typeof value !== "string") throw new InputError("slug", "must be text");
  const slug = value.trim().toLowerCase();
  if (!SLUG.test(slug)) throw new InputError("slug", "use letters, digits, - and _ (up to 64), starting with a letter or digit");
  if (RESERVED.has(slug)) throw new InputError("slug", `${slug} is reserved`);
  return slug;
}

function privateIPv4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

/** An IPv6 address as its eight groups (numbers), with :: filled in and a dotted IPv4 tail read. */
function groupsOf(ip: string): number[] {
  let text = ip.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, undefined];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  return [...h, ...Array(8 - h.length - t.length).fill("0"), ...t].map((g) => parseInt(g || "0", 16));
}

/**
 * Loopback, unspecified, unique-local, link-local and multicast; and an IPv4
 * address carried in IPv6 (::a.b.c.d, ::ffff:a.b.c.d, NAT64's 64:ff9b::/96,
 * 6to4's 2002::/16), judged as the IPv4 address it is.
 */
function privateIPv6(ip: string): boolean {
  const g = groupsOf(ip);
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) return g[5] === 0 && g[6] === 0 && g[7]! <= 1 ? true : privateIPv4(v4(g[6]!, g[7]!));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return privateIPv4(v4(g[6]!, g[7]!));
  if (g[0] === 0x2002) return privateIPv4(v4(g[1]!, g[2]!));
  return (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xff00) === 0xff00;
}

/** A target: an http or https URL to a public address (no localhost, private addresses or credentials). */
export function checkTarget(value: unknown, field = "target"): string {
  if (typeof value !== "string" || !value.trim()) throw new InputError(field, "must be a URL like https://example.com/page");
  const text = value.trim();
  if (text.length > 2048 || CONTROL.test(text)) throw new InputError(field, "must be one line, at most 2048 characters");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new InputError(field, "must be a URL like https://example.com/page");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new InputError(field, "must start with http:// or https://");
  if (url.username || url.password) throw new InputError(field, "can't carry a username or password");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new InputError(field, "can't point at this server (localhost)");
  const kind = isIP(host);
  if ((kind === 4 && privateIPv4(host)) || (kind === 6 && privateIPv6(host))) throw new InputError(field, "can't point at a private address");
  return url.href;
}

export function checkRedirect(value: unknown): Redirect {
  const n = Number(value);
  if (!(REDIRECTS as readonly number[]).includes(n)) throw new InputError("redirect", "must be 301, 302, 307 or 308");
  return n as Redirect;
}

export function checkTitle(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > 200 || CONTROL.test(value)) throw new InputError("title", "must be one line, at most 200 characters");
  return value.trim();
}

/** Up to 10 tags, as a list or comma-separated text. */
export function checkTags(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  const list = typeof value === "string" ? value.split(/[,|;]/) : value;
  if (!Array.isArray(list)) throw new InputError("tags", "must be a list of tags");
  const tags = [...new Set(list.map((t) => (typeof t === "string" ? t.trim() : "")).filter(Boolean))];
  if (tags.length > 10) throw new InputError("tags", "at most 10 tags");
  for (const t of tags) if (!TAG.test(t)) throw new InputError("tags", `"${t}" isn't a tag: letters, digits, spaces, . _ - (up to 32)`);
  return tags;
}

/** A moment (ms since 1970, or an ISO date) or null for never. */
export function checkExpiry(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(ms) || ms < 0) throw new InputError("expiresAt", "must be a date");
  return Math.floor(ms);
}

export function checkPassword(value: unknown): string {
  if (typeof value !== "string" || value.length > 200 || CONTROL.test(value)) throw new InputError("password", "must be one line, at most 200 characters");
  return value;
}

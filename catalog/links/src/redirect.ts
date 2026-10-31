// The public side: a short link answers with a redirect (302 unless the link
// says otherwise), the incoming query string passed on unless the link turns
// that off. Slugs match without regard to case. The bare domain and unknown
// slugs go where the settings say, or get a plain page. A link that's turned
// off or expired answers 410, and one with a password shows a form first; a
// correct password sets a signed cookie for that link only.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { Clicks } from "./clicks.ts";
import { getSetting, setSetting } from "./db.ts";
import { clientIp } from "./geo.ts";
import { html, readBody, send } from "./http.ts";
import { gonePage, homePage, notFoundPage, passwordPage } from "./pages.ts";
import type { Settings } from "./settings.ts";
import { passwordMatches, type Link, type Store } from "./store.ts";

export interface PublicContext {
  store: Store;
  clicks: Clicks;
  settings: () => Settings;
  /** Signs the cookies of password-protected links. */
  cookieSecret: string;
}

/** The secret for password cookies: made once and kept in the database. */
export function cookieSecret(db: DatabaseSync): string {
  const stored = getSetting(db, "cookie_secret");
  if (stored) return stored;
  const secret = randomBytes(32).toString("hex");
  setSetting(db, "cookie_secret", secret);
  return secret;
}

const UNLOCK_DAYS = 30;
const cookieName = (link: Link) => `links_pw_${link.id}`;
// The password hash is part of what's signed: changing the password locks every browser out again.
const signature = (link: Link, expires: number, secret: string) => createHmac("sha256", secret).update(`${link.id}.${expires}.${link.passwordHash}`).digest("base64url");

function unlocked(req: IncomingMessage, link: Link, secret: string): boolean {
  const cookie = (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${cookieName(link)}=`));
  const [expires, sig] = (cookie?.slice(cookieName(link).length + 1) ?? "").split(".");
  if (!expires || !sig || Number(expires) < Date.now()) return false;
  const want = Buffer.from(signature(link, Number(expires), secret));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Ten password tries per address and link every ten minutes. */
const tries = new Map<string, { n: number; until: number }>();
function tooManyTries(key: string, now: number): boolean {
  const t = tries.get(key);
  if (!t || t.until < now) {
    if (tries.size > 10_000) tries.clear();
    tries.set(key, { n: 1, until: now + 10 * 60_000 });
    return false;
  }
  return ++t.n > 10;
}

/** The target with the visitor's query string added (theirs wins over the target's own values). */
export function withQuery(target: string, query: URLSearchParams): string {
  const url = new URL(target);
  for (const [k, v] of query) url.searchParams.set(k, v);
  return url.href;
}

function redirect(res: ServerResponse, status: number, location: string): void {
  // 302 and 307 aren't cached, so every click reaches the server; 301 and 308
  // are kept a day by browsers, so a changed target still takes over.
  const cache = status === 301 || status === 308 ? "public, max-age=86400" : "no-store";
  send(res, status, "", { Location: location, "Cache-Control": cache });
}

export async function handlePublic(req: IncomingMessage, res: ServerResponse, ctx: PublicContext, url: URL): Promise<void> {
  if (url.pathname === "/robots.txt") return send(res, 200, "User-agent: *\nDisallow: /\n", { "Content-Type": "text/plain" });
  // Browsers ask for it on every visit: no icon, and not a click.
  if (url.pathname === "/favicon.ico") return send(res, 204, "");
  if (!["GET", "HEAD", "POST"].includes(req.method ?? "")) return send(res, 405, "", { Allow: "GET, HEAD, POST" });
  const settings = ctx.settings();
  if (url.pathname === "/") {
    if (req.method === "POST") return send(res, 405, "", { Allow: "GET, HEAD" });
    return settings.home ? redirect(res, 302, settings.home) : html(res, 200, homePage());
  }
  let slug: string;
  try {
    slug = decodeURIComponent(url.pathname.slice(1)).replace(/\/+$/, "");
  } catch {
    return html(res, 404, notFoundPage());
  }
  const link = ctx.store.bySlug(slug);
  if (!link) return settings.missing && req.method !== "POST" ? redirect(res, 302, settings.missing) : html(res, 404, notFoundPage());
  if (link.disabled || (link.expiresAt !== null && link.expiresAt <= Date.now())) return html(res, 410, gonePage());
  const target = link.passQuery && url.search ? withQuery(link.target, url.searchParams) : link.target;

  if (link.passwordHash && !unlocked(req, link, ctx.cookieSecret)) {
    if (req.method !== "POST") return html(res, 200, passwordPage());
    const now = Date.now();
    if (tooManyTries(`${clientIp(req)}|${link.id}`, now)) return html(res, 429, passwordPage("Too many tries. Wait a few minutes."), { "Retry-After": "600" });
    const password = new URLSearchParams((await readBody(req, 4096)).toString("utf8")).get("password") ?? "";
    if (!passwordMatches(link.passwordHash, password)) return html(res, 403, passwordPage("That password isn't right."));
    const expires = now + UNLOCK_DAYS * 86_400_000;
    ctx.clicks.record(link, req, now);
    return send(res, 303, "", {
      Location: target,
      "Cache-Control": "no-store",
      "Set-Cookie": `${cookieName(link)}=${expires}.${signature(link, expires, ctx.cookieSecret)}; Path=/${encodeURIComponent(link.slug)}; Max-Age=${UNLOCK_DAYS * 86_400}; HttpOnly; Secure; SameSite=Lax`,
    });
  }
  if (req.method === "POST") return send(res, 405, "", { Allow: "GET, HEAD" });
  // HEAD is link checkers and previews asking whether it exists: not a click.
  if (req.method === "GET") ctx.clicks.record(link, req);
  redirect(res, link.redirect, target);
}

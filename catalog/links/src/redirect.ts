// The public side: a short link answers with a redirect (302 unless the link
// says otherwise), the incoming query string passed on unless the link turns
// that off. Slugs match without regard to case. The bare domain and unknown
// slugs go where the settings say, or get a plain page. A link that's turned
// off or expired answers 410, and one with a password shows a form first; a
// correct password sets a signed cookie for that link only.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { clientIp } from "../../lib/geo.ts";
import { html, readBody, send } from "../../lib/http.ts";
import { Limiter, limitKey } from "../../lib/limit.ts";
import type { Clicks } from "./clicks.ts";
import { getSetting, setSetting } from "./db.ts";
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

/**
 * Password tries: ten per address (an IPv6 /64) and link every ten minutes,
 * and a hundred per link an hour from everywhere, so many addresses together
 * can't guess a short password either.
 */
const triesFrom = new Limiter(10, 10 * 60_000);
const triesOf = new Limiter(100, 60 * 60_000, 10_000);

/** The target with the visitor's query string added; the target's own parameters stay as the link says. */
export function withQuery(target: string, query: URLSearchParams): string {
  const url = new URL(target);
  for (const [k, v] of query) if (!url.searchParams.has(k)) url.searchParams.append(k, v);
  return url.href;
}

/** A slug's longest path: anything longer isn't a link (and is no work to turn away). */
const MAX_PATH = 256;

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
  if (url.pathname.length > MAX_PATH) return html(res, 404, notFoundPage());
  let slug: string;
  try {
    slug = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return html(res, 404, notFoundPage());
  }
  // Trailing slashes off, by hand: a regex for it takes quadratic time on a run of them.
  let end = slug.length;
  while (end > 0 && slug[end - 1] === "/") end--;
  slug = slug.slice(0, end);
  const link = ctx.store.bySlug(slug);
  if (!link) return settings.missing && req.method !== "POST" ? redirect(res, 302, settings.missing) : html(res, 404, notFoundPage());
  if (link.disabled || (link.expiresAt !== null && link.expiresAt <= Date.now())) return html(res, 410, gonePage());
  const target = link.passQuery && url.search ? withQuery(link.target, url.searchParams) : link.target;

  if (link.passwordHash && !unlocked(req, link, ctx.cookieSecret)) {
    // The form may send the visitor on to the target's own site (a redirect counts as the form's action).
    const csp = { "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(target).origin}; frame-ancestors 'none'` };
    if (req.method !== "POST") return html(res, 200, passwordPage(), csp);
    const now = Date.now();
    const from = `${limitKey(clientIp(req))}|${link.id}`;
    if (triesFrom.over(from, now) || triesOf.over(String(link.id), now)) return html(res, 429, passwordPage("Too many tries. Wait a few minutes."), { ...csp, "Retry-After": "600" });
    const password = new URLSearchParams((await readBody(req, 4096)).toString("utf8")).get("password") ?? "";
    if (!(await passwordMatches(link.passwordHash, password))) {
      triesFrom.hit(from, now);
      triesOf.hit(String(link.id), now);
      return html(res, 403, passwordPage("That password isn't right."), csp);
    }
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

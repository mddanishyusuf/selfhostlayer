// Forms as one HTTP server: /healthz, the forms' pages and their answers
// (/f/<slug>…), /embed.js, and the admin API (/_admin/…, this server only).
// Notifications go out in the background.
import { randomBytes } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { clientIp, loadGeo, type Geo } from "../../lib/geo.ts";
import { fail, InputError, json, readBody, send } from "../../lib/http.ts";
import { Secrets } from "../../lib/secrets.ts";
import { readAgent, referrerHost } from "../../lib/ua.ts";
import { handleAdmin, type AdminContext } from "./admin.ts";
import { checkAnswers } from "./answers.ts";
import { getSetting, openDb, setSetting } from "./db.ts";
import { Forms } from "./forms.ts";
import { Notifier } from "./notify.ts";
import { closedPage, EMBED_JS, formPage, missingPage, pageHeaders } from "./page.ts";
import { Responses } from "./responses.ts";

export interface AppOptions {
  dataDir: string;
  /** The admin API's token (FORMS_ADMIN_TOKEN). */
  token: string;
  /** Signs each page's start time (FORMS_SECRET). */
  secret: string;
  releaseDir: string;
  version: string;
  /** false: nothing runs in the background (tests drive it by hand). */
  background?: boolean;
  fetch?: typeof fetch;
  /** The shortest time between a page's load and its answers. */
  minMs?: number;
}

export interface App {
  server: Server;
  db: DatabaseSync;
  forms: Forms;
  responses: Responses;
  notifier: Notifier;
  secrets: Secrets;
  publicUrl: () => string;
  close: () => Promise<void>;
}

const MAX_BODY = 40 * 1024 * 1024;
const DAY = 86_400_000;
const mtime = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

export function createApp(o: AppOptions): App {
  mkdirSync(o.dataDir, { recursive: true });
  const db = openDb(join(o.dataDir, "forms.db"));
  const secrets = new Secrets(o.token, o.secret, "forms");
  const forms = new Forms(db);
  const responses = new Responses(db, o.dataDir);
  const notifier = new Notifier({ db, forms, responses, secrets, fetch: o.fetch });
  let publicUrl = getSetting(db, "publicUrl") ?? "http://127.0.0.1";
  const ctx: AdminContext = { forms, responses, notifier, token: o.token, version: o.version, publicUrl: () => publicUrl, setPublicUrl: (u) => ((publicUrl = u), setSetting(db, "publicUrl", u)) };
  const geoPaths = [join(o.dataDir, "geo.bin"), join(o.releaseDir, "geo.bin")];
  let geo = loadGeo(geoPaths);
  let geoSeen = mtime(geoPaths[0]!);
  const minMs = o.minMs ?? 2000;

  const timers: NodeJS.Timeout[] = [];
  if (o.background !== false) {
    const t = setInterval(() => notifier.tick().catch((err: unknown) => console.error(`notifications failed: ${(err as Error).message}`)), 5000);
    const g = setInterval(() => {
      const seen = mtime(geoPaths[0]!);
      if (seen > geoSeen) {
        geoSeen = seen;
        geo = loadGeo(geoPaths) ?? geo;
      }
    }, 3_600_000);
    t.unref();
    g.unref();
    timers.push(t, g);
  }

  const limits = new Map<string, { n: number; reset: number }>();
  const limited = (key: string, max: number, now: number) => {
    const w = limits.get(key);
    if (!w || w.reset <= now) {
      if (limits.size > 20_000) limits.clear();
      limits.set(key, { n: 1, reset: now + 60_000 });
      return false;
    }
    return ++w.n > max;
  };

  /** The start token: when the page was made, signed. */
  const token = (slug: string, now: number) => `${now}.${secrets.sign("t", slug, String(now))}`;
  const tokenAge = (slug: string, t: unknown, now: number): number | null => {
    const m = typeof t === "string" ? /^(\d{10,16})\.([\w-]{22})$/.exec(t) : null;
    if (!m || !secrets.verify(m[2]!, "t", slug, m[1]!)) return null;
    return now - Number(m[1]);
  };

  async function submit(req: IncomingMessage, slug: string, now: number): Promise<{ status: number; body: Record<string, unknown> }> {
    const form = forms.bySlug(slug);
    if (!form) return { status: 404, body: { error: "There's no form here." } };
    const closed = forms.closedBecause(form, now);
    if (closed) return { status: 410, body: { error: form.closedMessage || "This form isn't taking answers any more." } };
    const ip = clientIp(req) ?? "";
    if (limited(`${ip}|${form.id}`, 10, now)) return { status: 429, body: { error: "Too many answers from here: wait a minute." } };
    let input: Record<string, unknown>;
    try {
      const v = JSON.parse((await readBody(req, MAX_BODY)).toString("utf8")) as unknown;
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
      input = v as Record<string, unknown>;
    } catch (err) {
      if (err instanceof InputError) throw err;
      return { status: 400, body: { error: "The answers couldn't be read." } };
    }
    // A bot that filled in the hidden field is told all went well.
    if (typeof input.hp === "string" && input.hp) return { status: 200, body: { ok: true } };
    const age = tokenAge(slug, input.t, now);
    if (age === null || age > DAY) return { status: 400, body: { error: "The page is too old: load it again." } };
    if (age < minMs) return { status: 400, body: { error: "That was too fast: try again." } };
    const agent = readAgent(req.headers["user-agent"]);
    if (agent.bot) return { status: 200, body: { ok: true } };
    const { answers, uploads } = checkAnswers(form.schema, input as { answers?: unknown; files?: unknown });
    const referrer = referrerHost(typeof req.headers.referer === "string" ? req.headers.referer : undefined, new URL(publicUrl).hostname);
    const rid = responses.store(form, answers, uploads, { duration: age, country: ip ? (geo?.geo.country(ip) ?? null) : null, device: agent.device, browser: agent.browser, referrer }, now);
    notifier.queue(form, rid, now);
    return { status: 200, body: { ok: true, id: rid } };
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://forms");
    const now = Date.now();
    const run = async () => {
      const p = url.pathname;
      if (p === "/healthz") return send(res, 200, "ok\n", { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      if (p === "/_admin" || p.startsWith("/_admin/")) return handleAdmin(req, res, ctx, url);
      if (p === "/embed.js") return send(res, 200, EMBED_JS, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" });
      const m = /^\/f\/([a-z0-9-]{1,50})(?:\/(submit|view|start))?\/?$/.exec(p);
      if (m) {
        const [, slug, action] = m as unknown as [string, string, string | undefined];
        if (!action) {
          if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "", { Allow: "GET" });
          const nonce = randomBytes(16).toString("base64");
          const form = forms.bySlug(slug);
          const embed = url.searchParams.get("embed") === "1";
          if (!form) return send(res, 404, missingPage(nonce), pageHeaders(nonce));
          if (forms.closedBecause(form, now)) return send(res, 200, closedPage(form, { embed, nonce }), pageHeaders(nonce));
          return send(res, 200, formPage(form, { base: `/f/${slug}`, token: token(slug, now), embed, nonce }), pageHeaders(nonce));
        }
        if (req.method !== "POST") return send(res, 405, "", { Allow: "POST" });
        if (action === "submit") {
          const r = await submit(req, slug, now);
          return json(res, r.status, r.body);
        }
        // View and start beacons: counted for people, once per page.
        await readBody(req, 1024).catch(() => Buffer.alloc(0));
        const form = forms.bySlug(slug);
        if (form && !readAgent(req.headers["user-agent"]).bot && !limited(`${action}|${clientIp(req) ?? ""}|${form.id}`, 30, now)) forms.count(form.id, action === "view" ? "views" : "starts");
        return send(res, 204, "");
      }
      if (p === "/") return send(res, 200, "Forms by Self Host Layer: forms live at /f/<slug>.\n", { "Content-Type": "text/plain; charset=utf-8" });
      json(res, 404, { error: "not found" });
    };
    run().catch((err: unknown) => {
      // A form's own answer errors name the field, for the page to show by it.
      if (err instanceof InputError && url.pathname.endsWith("/submit") && !res.headersSent) return json(res, err.status === 400 ? 422 : err.status, { error: err.message, field: err.field });
      fail(res, err);
    });
  });
  server.keepAliveTimeout = 65_000;

  return {
    server,
    db,
    forms,
    responses,
    notifier,
    secrets,
    publicUrl: () => publicUrl,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearInterval(t);
        server.close(() => resolve());
        server.closeIdleConnections();
      }).finally(() => db.close()),
  };
}

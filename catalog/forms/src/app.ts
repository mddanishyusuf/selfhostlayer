// Forms as one HTTP server: /healthz, the forms' pages and their answers
// (/f/<slug>…), /embed.js, and the admin API (/_admin/…, this server only).
// Notifications go out in the background.
//
// The page sends a response as one request (FORMAT): a line of JSON with the
// answers and each file's field, name, type and size, then the files' bytes
// one after another. Everything is checked before a file's bytes are read, and
// files go straight to disk: a response never sits in memory, however big.
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, statfsSync, statSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { clientIp, loadGeo, type Geo } from "../../lib/geo.ts";
import { fail, InputError, json, readBody, send } from "../../lib/http.ts";
import { Limiter, limitKey } from "../../lib/limit.ts";
import { Secrets } from "../../lib/secrets.ts";
import { readAgent, referrerHost } from "../../lib/ua.ts";
import { handleAdmin, type AdminContext } from "./admin.ts";
import { checkAnswers, maxAnswersBytes } from "./answers.ts";
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

const FORMAT = "application/x-forms-response";
const DAY = 86_400_000;
/** Responses with files coming in at once (each up to 25 MB on disk while it does). */
const UPLOADS_AT_ONCE = 8;
/** Files wait while the disk has less than this free, or 5% of it. */
const DISK_FLOOR = 1024 ** 3;

/** A response as the page sends it (FORMAT), read a piece at a time. */
class Submission {
  readonly #chunks: AsyncIterator<Buffer>;
  #left: Buffer = Buffer.alloc(0);

  constructor(req: IncomingMessage) {
    this.#chunks = req[Symbol.asyncIterator]();
  }

  async #more(): Promise<boolean> {
    const { value, done } = await this.#chunks.next();
    if (done) return false;
    this.#left = this.#left.length ? Buffer.concat([this.#left, value as Buffer]) : (value as Buffer);
    return true;
  }

  /** The line of JSON, at most max bytes. */
  async head(max: number): Promise<Record<string, unknown>> {
    let from = 0;
    let at: number;
    while ((at = this.#left.indexOf(10, from)) < 0) {
      if (this.#left.length > max) throw new InputError("body", "the answers are too long", 413);
      from = this.#left.length;
      if (!(await this.#more())) throw new InputError("body", "the answers couldn't be read");
    }
    if (at > max) throw new InputError("body", "the answers are too long", 413);
    const line = this.#left.subarray(0, at).toString("utf8");
    this.#left = this.#left.subarray(at + 1);
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      v = null;
    }
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new InputError("body", "the answers couldn't be read");
    return v as Record<string, unknown>;
  }

  /** The next `size` bytes, into a new file. */
  async file(path: string, size: number): Promise<void> {
    const fd = openSync(path, "wx", 0o600);
    try {
      for (let need = size; need > 0; ) {
        if (!this.#left.length && !(await this.#more())) throw new InputError("files", "a file didn't come whole: try again");
        const piece = this.#left.subarray(0, need);
        for (let off = 0; off < piece.length; ) off += writeSync(fd, piece, off);
        need -= piece.length;
        this.#left = this.#left.subarray(piece.length);
      }
    } finally {
      closeSync(fd);
    }
  }

  /** That nothing came after the files. */
  async end(): Promise<void> {
    if (this.#left.length || (await this.#more())) throw new InputError("files", "more came than the files announced");
  }
}

/** Whether the disk has room for `bytes` more, above the floor. */
function roomFor(dir: string, bytes: number): boolean {
  const s = statfsSync(dir);
  return s.bavail * s.bsize - bytes >= Math.max(DISK_FLOOR, s.blocks * s.bsize * 0.05);
}
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
  const ctx: AdminContext = { forms, responses, notifier, token: o.token, version: o.version, publicUrl: () => publicUrl, setPublicUrl: (u) => ((publicUrl = u), setSetting(db, "publicUrl", u)), previewToken: (slug) => secrets.sign("preview", slug) };
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

  // Answers from one address to a form, and views and starts it counts, a minute (IPv6 by its /64).
  const answersFrom = new Limiter(10, 60_000);
  const beaconsFrom = new Limiter(30, 60_000);
  // A crash can leave files that were coming in: nothing ever reads them.
  rmSync(responses.staging, { recursive: true, force: true });
  mkdirSync(responses.staging, { recursive: true, mode: 0o700 });
  let uploading = 0;

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
    if (answersFrom.hit(`${limitKey(ip)}|${form.id}`)) return { status: 429, body: { error: "Too many answers from here: wait a minute." } };
    const max = maxAnswersBytes(form.schema);
    const sub = String(req.headers["content-type"] ?? "").startsWith(FORMAT) ? new Submission(req) : null;
    let input: Record<string, unknown>;
    try {
      if (sub) input = await sub.head(max);
      else {
        // JSON, from a page loaded before files came this way: answers only.
        const v = JSON.parse((await readBody(req, max)).toString("utf8")) as unknown;
        if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
        input = v as Record<string, unknown>;
        const files = input.files;
        if (files && typeof files === "object" && Object.keys(files).length) return { status: 409, body: { error: "This page changed since it was loaded: load it again to send files." } };
        input.files = [];
      }
    } catch (err) {
      if (err instanceof InputError && err.status === 413) return { status: 413, body: { error: sub ? "The answers are too long." : "This page changed since it was loaded: load it again." } };
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
    // Everything checked: now the files' bytes, if any came (all are read, even a hidden question's, then dropped).
    const announced = (input.files as { size: number }[] | undefined) ?? [];
    const coming = announced.reduce((n, f) => n + f.size, 0);
    const paths: string[] = [];
    if (sub) {
      if (announced.length) {
        if (uploading >= UPLOADS_AT_ONCE) return { status: 503, body: { error: "Busy with other files: try again in a minute." } };
        if (!roomFor(responses.staging, coming)) return { status: 507, body: { error: "The server is short of room for files: try again later." } };
      }
      uploading += announced.length ? 1 : 0;
      try {
        for (const f of announced) {
          const path = join(responses.staging, randomBytes(12).toString("hex"));
          paths.push(path);
          await sub.file(path, f.size);
        }
        await sub.end();
      } catch (err) {
        for (const p of paths) rmSync(p, { force: true });
        throw err;
      } finally {
        uploading -= announced.length ? 1 : 0;
      }
    }
    const referrer = referrerHost(typeof req.headers.referer === "string" ? req.headers.referer : undefined, new URL(publicUrl).hostname);
    try {
      const rid = responses.store(form, answers, uploads.map((u) => ({ ...u, path: paths[u.index]! })), { duration: age, country: ip ? (geo?.geo.country(ip) ?? null) : null, device: agent.device, browser: agent.browser, referrer }, now);
      notifier.queue(form, rid, now);
      return { status: 200, body: { ok: true, id: rid } };
    } finally {
      // Files the response doesn't keep (a hidden question's), or all of them if it failed.
      for (const p of paths) rmSync(p, { force: true });
    }
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
          // The panel's builder shows the form even while it's closed.
          const preview = secrets.verify(url.searchParams.get("preview") ?? "", "preview", slug);
          if (!preview && forms.closedBecause(form, now)) return send(res, 200, closedPage(form, { embed, nonce }), pageHeaders(nonce));
          return send(res, 200, formPage(form, { base: `/f/${slug}`, token: token(slug, now), embed, nonce, preview }), pageHeaders(nonce));
        }
        if (req.method !== "POST") return send(res, 405, "", { Allow: "POST" });
        if (action === "submit") {
          const r = await submit(req, slug, now);
          return json(res, r.status, r.body);
        }
        // View and start beacons: counted for people, once per page.
        await readBody(req, 1024).catch(() => Buffer.alloc(0));
        const form = forms.bySlug(slug);
        if (form && !readAgent(req.headers["user-agent"]).bot && !beaconsFrom.hit(`${action}|${limitKey(clientIp(req))}|${form.id}`)) forms.count(form.id, action === "view" ? "views" : "starts");
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

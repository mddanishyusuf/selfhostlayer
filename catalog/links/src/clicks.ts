// Clicks, written off the redirect path: queued in memory and written in one
// transaction every second, or at 100 clicks. A crash loses at most a
// second of clicks, never a link. Each click keeps its time, referring site,
// country, device, browser, OS and whether a bot made it. Visitors are counted
// with a hash of their address and User-Agent under a salt that changes every
// day (the old one is thrown away): no address or cookie is stored, and
// nobody can be followed from one day to the next.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { clientIp, type Geo } from "../../lib/geo.ts";
import { readAgent, referrerHost } from "../../lib/ua.ts";
import { getSetting, setSetting } from "./db.ts";
import type { Link, Store } from "./store.ts";

export interface Click {
  linkId: number;
  at: number;
  referrer: string | null;
  country: string | null;
  device: string;
  browser: string;
  os: string;
  bot: boolean;
  visitor: string;
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class Clicks {
  readonly #db: DatabaseSync;
  readonly #store: Store;
  readonly #geo: () => Geo | null;
  readonly #batch: number;
  #queue: Click[] = [];
  #salt: { day: string; value: string } | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(db: DatabaseSync, store: Store, geo: () => Geo | null, opts: { flushMs?: number; batch?: number } = {}) {
    this.#db = db;
    this.#store = store;
    this.#geo = geo;
    this.#batch = opts.batch ?? 100;
    if (opts.flushMs !== 0) this.#timer = setInterval(() => this.#tryFlush(), opts.flushMs ?? 1000).unref();
  }

  /** A flush from a timer: a failure is logged, and the clicks wait for the next one. */
  #tryFlush(): void {
    try {
      this.flush();
    } catch (err) {
      console.error(`writing clicks failed (kept for the next try): ${(err as Error).message}`);
    }
  }

  /** Today's salt, the same for every process (stored), replaced when the day changes. */
  #saltFor(now: number): string {
    const day = utcDay(now);
    if (this.#salt?.day === day) return this.#salt.value;
    const stored = getSetting(this.#db, "salt");
    const parsed = stored ? (JSON.parse(stored) as { day: string; value: string }) : null;
    this.#salt = parsed?.day === day ? parsed : { day, value: randomBytes(16).toString("hex") };
    if (parsed?.day !== day) setSetting(this.#db, "salt", JSON.stringify(this.#salt));
    return this.#salt.value;
  }

  record(link: Link, req: IncomingMessage, now = Date.now()): Click {
    const ua = req.headers["user-agent"];
    const agent = readAgent(ua);
    const ip = clientIp(req);
    const click: Click = {
      linkId: link.id,
      at: now,
      referrer: referrerHost(req.headers.referer, req.headers.host),
      country: ip ? (this.#geo()?.country(ip) ?? null) : null,
      device: agent.device,
      browser: agent.browser,
      os: agent.os,
      bot: agent.bot,
      visitor: createHash("sha256").update(`${this.#saltFor(now)}|${ip ?? ""}|${ua ?? ""}`).digest("hex").slice(0, 16),
    };
    this.#queue.push(click);
    if (this.#queue.length === this.#batch) setImmediate(() => this.#tryFlush());
    return click;
  }

  get pending(): number {
    return this.#queue.length;
  }

  /** Writes the queued clicks in one transaction, and adds them to each link's count. */
  flush(): number {
    if (!this.#queue.length) return 0;
    const clicks = this.#queue;
    this.#queue = [];
    const counts = new Map<number, number>();
    for (const c of clicks) if (!c.bot) counts.set(c.linkId, (counts.get(c.linkId) ?? 0) + 1);
    const insert = this.#db.prepare("INSERT INTO clicks (link_id, at, referrer, country, device, browser, os, bot, visitor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const bump = this.#db.prepare("UPDATE links SET clicks = clicks + ? WHERE id = ?");
    this.#db.exec("BEGIN");
    try {
      for (const c of clicks) insert.run(c.linkId, c.at, c.referrer, c.country, c.device, c.browser, c.os, c.bot ? 1 : 0, c.visitor);
      for (const [id, n] of counts) bump.run(n, id);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      // Kept for the next try rather than lost (a busy database clears up).
      this.#queue = [...clicks, ...this.#queue];
      throw err;
    }
    this.#store.addClicks(counts);
    return clicks.length;
  }

  close(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.flush();
  }
}

// Analytics as one HTTP server: /healthz, /script.js, POST /api/event (from
// any site's pages), POST /webhooks/<provider>/<site> (Creem's and Lemon
// Squeezy's payments), and the admin API (/_admin/…, this server only).
// Payments are pulled from the other providers every 10 minutes.
import { mkdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadGeo, type Geo } from "../../lib/geo.ts";
import { fail, InputError, json, readBody, send } from "../../lib/http.ts";
import { handleAdmin, type AdminContext } from "./admin.ts";
import { openDb } from "./db.ts";
import { Ingest } from "./ingest.ts";
import { Revenue, type RevenueOptions, SIGNATURE_HEADERS, SYNC_EVERY } from "./revenue.ts";
import { SCRIPT } from "./script.ts";
import { Sites } from "./sites.ts";

export interface AppOptions {
  dataDir: string;
  /** The admin API's token (ANALYTICS_ADMIN_TOKEN). */
  token: string;
  /** Where the release's own geo.bin is. */
  releaseDir: string;
  version: string;
  /** How often queued events are written; 0 only when written by hand (tests). */
  flushMs?: number;
  /** Where payments are pulled from, instead of the providers (tests). */
  providers?: Pick<RevenueOptions, "fetch" | "bases">;
  /** false: payments are pulled only when asked (tests). */
  syncTimer?: boolean;
}

export interface App {
  server: Server;
  db: DatabaseSync;
  sites: Sites;
  ingest: Ingest;
  revenue: Revenue;
  geo: () => Geo | null;
  close: () => Promise<void>;
}

// Any site's pages may send events; nothing comes back but a status.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" };

const mtime = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

export function createApp(o: AppOptions): App {
  mkdirSync(o.dataDir, { recursive: true });
  const db = openDb(join(o.dataDir, "analytics.db"));
  const sites = new Sites(db);
  const geoPaths = [join(o.dataDir, "geo.bin"), join(o.releaseDir, "geo.bin")];
  let geo = loadGeo(geoPaths);
  let geoSeen = mtime(geoPaths[0]!);
  const ingest = new Ingest(db, sites, () => geo?.geo ?? null, { flushMs: o.flushMs });
  const revenue = new Revenue(db, { secret: o.token, flush: () => ingest.flush(), ...o.providers });
  const ctx: AdminContext = { db, sites, ingest, revenue, token: o.token, version: o.version, geoSource: () => geo?.geo.source ?? null };
  const syncAll = () => {
    if (!revenue.busy) revenue.syncAll().catch((err: unknown) => console.error(`pulling payments failed: ${(err as Error).message}`));
  };
  const timers = [
    // Sites added by the other color during a deploy.
    setInterval(() => {
      try {
        sites.refresh();
      } catch (err) {
        console.error(`reloading sites failed: ${(err as Error).message}`);
      }
    }, 1000),
    // A fresher list of countries from the monthly job.
    setInterval(() => {
      const seen = mtime(geoPaths[0]!);
      if (seen > geoSeen) {
        geoSeen = seen;
        geo = loadGeo(geoPaths) ?? geo;
      }
    }, 3_600_000),
    ...(o.syncTimer === false ? [] : [setTimeout(syncAll, 30_000), setInterval(syncAll, SYNC_EVERY)]),
  ];
  for (const t of timers) t.unref();

  async function event(req: Parameters<typeof handleAdmin>[0], res: Parameters<typeof handleAdmin>[1]): Promise<void> {
    if (req.method === "OPTIONS") return send(res, 204, "", CORS);
    if (req.method !== "POST") return send(res, 405, "", { ...CORS, Allow: "POST, OPTIONS" });
    let input: Record<string, unknown>;
    try {
      const value = JSON.parse((await readBody(req, 4096)).toString("utf8")) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
      input = value as Record<string, unknown>;
    } catch (err) {
      if (err instanceof InputError) throw err;
      throw new InputError("body", "must be a JSON object");
    }
    const r = ingest.record(input, req);
    res.writeHead(202, { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(`${JSON.stringify(r)}\n`);
  }

  /** A payment provider's webhook, signed with the secret kept for its site. */
  async function webhook(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    const m = /^\/webhooks\/([a-z]{1,20})\/(\d{1,9})$/.exec(url.pathname);
    if (!m) return json(res, 404, { error: "not found" });
    const [, provider, site] = m as unknown as [string, string, string];
    const raw = await readBody(req, 1024 * 1024);
    const header = SIGNATURE_HEADERS[provider];
    const r = revenue.receive(Number(site), provider, raw, header ? [req.headers[header]].flat()[0] : undefined);
    json(res, 200, { received: true, added: r.added });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://analytics");
    const route =
      url.pathname === "/healthz"
        ? Promise.resolve(send(res, 200, "ok\n", { "Content-Type": "text/plain", "Cache-Control": "no-store" }))
        : url.pathname === "/script.js"
          ? Promise.resolve(send(res, 200, SCRIPT, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" }))
          : url.pathname === "/api/event"
            ? event(req, res)
            : url.pathname.startsWith("/webhooks/")
              ? webhook(req, res, url)
              : url.pathname === "/_admin" || url.pathname.startsWith("/_admin/")
              ? handleAdmin(req, res, ctx, url)
              : url.pathname === "/"
                ? Promise.resolve(send(res, 200, "Analytics by Self Host Layer: this address takes events from its sites' pages.\n", { "Content-Type": "text/plain; charset=utf-8" }))
                : Promise.resolve(json(res, 404, { error: "not found" }));
    route.catch((err: unknown) => {
      // The event endpoint's errors carry CORS headers, so a site's console shows why.
      if (url.pathname === "/api/event" && !res.headersSent) for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
      fail(res, err);
    });
  });
  server.keepAliveTimeout = 65_000;

  return {
    server,
    db,
    sites,
    ingest,
    revenue,
    geo: () => geo?.geo ?? null,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearTimeout(t);
        server.close(() => resolve());
        server.closeIdleConnections();
      }).finally(() => {
        ingest.close();
        db.close();
      }),
  };
}

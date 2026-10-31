// Links as one HTTP server: /healthz, the admin API (/_admin/…, this server
// only), the public API (/api/v1/…) and every other path a short link.
import { mkdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadGeo, type Geo } from "../../lib/geo.ts";
import { fail, send } from "../../lib/http.ts";
import { handleAdmin, type AdminContext } from "./admin.ts";
import { handleApi } from "./api.ts";
import { Clicks } from "./clicks.ts";
import { openDb } from "./db.ts";
import { cookieSecret, handlePublic } from "./redirect.ts";
import { readSettings, saveSettings } from "./settings.ts";
import { Store } from "./store.ts";

export interface AppOptions {
  dataDir: string;
  /** The admin API's token (LINKS_ADMIN_TOKEN). */
  token: string;
  /** Where the release's own geo.bin is. */
  releaseDir: string;
  version: string;
  /** How often queued clicks are written; 0 only when written by hand (tests). */
  flushMs?: number;
}

export interface App {
  server: Server;
  db: DatabaseSync;
  store: Store;
  clicks: Clicks;
  geo: () => Geo | null;
  close: () => Promise<void>;
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
  const db = openDb(join(o.dataDir, "links.db"));
  let settings = readSettings(db);
  const store = new Store(db, () => settings);
  const geoPaths = [join(o.dataDir, "geo.bin"), join(o.releaseDir, "geo.bin")];
  let geo = loadGeo(geoPaths);
  let geoSeen = mtime(geoPaths[0]!);
  const clicks = new Clicks(db, store, () => geo?.geo ?? null, { flushMs: o.flushMs });
  const ctx: AdminContext = {
    db,
    store,
    clicks,
    settings: () => settings,
    cookieSecret: cookieSecret(db),
    token: o.token,
    version: o.version,
    geoSource: () => geo?.geo.source ?? null,
    saveSettings: (input) => (settings = saveSettings(db, input)),
  };
  const timers = [
    // Changes from the other color during a deploy, or from a cron job.
    setInterval(() => {
      try {
        if (store.refresh()) settings = readSettings(db);
      } catch (err) {
        console.error(`reloading links failed: ${(err as Error).message}`);
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
  ];
  for (const t of timers) t.unref();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://links");
    const route =
      url.pathname === "/healthz"
        ? Promise.resolve(send(res, 200, "ok\n", { "Content-Type": "text/plain", "Cache-Control": "no-store" }))
        : url.pathname === "/_admin" || url.pathname.startsWith("/_admin/")
          ? handleAdmin(req, res, ctx, url)
          : url.pathname === "/api" || url.pathname.startsWith("/api/")
            ? handleApi(req, res, ctx, url)
            : handlePublic(req, res, ctx, url);
    route.catch((err: unknown) => fail(res, err));
  });
  server.keepAliveTimeout = 65_000;

  return {
    server,
    db,
    store,
    clicks,
    geo: () => geo?.geo ?? null,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearInterval(t);
        server.close(() => resolve());
        server.closeIdleConnections();
      }).finally(() => {
        clicks.close();
        db.close();
      }),
  };
}

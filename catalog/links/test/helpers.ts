import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import type { Settings } from "../src/settings.ts";

export const DEFAULT_SETTINGS: Settings = { home: "", missing: "", defaultRedirect: 302, keepDays: 90 };
export const TOKEN = "t".repeat(64);
export const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export interface Running {
  app: App;
  base: string;
  dataDir: string;
  admin: (path: string, init?: RequestInit) => Promise<Response>;
  stop: () => Promise<void>;
}

/** Links on a free port with a fresh data folder; clicks are written by hand (app.clicks.flush()). */
export async function start(dataDir = mkdtempSync(join(tmpdir(), "links-"))): Promise<Running> {
  const app = createApp({ dataDir, token: TOKEN, releaseDir: dataDir, version: "test", flushMs: 0 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return {
    app,
    base,
    dataDir,
    admin: (path, init = {}) => fetch(`${base}/_admin/${path}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers } }),
    stop: () => app.close(),
  };
}

export const cleanup = (dir: string) => rmSync(dir, { recursive: true, force: true });

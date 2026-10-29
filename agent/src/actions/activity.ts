// Reading the logs that sit behind the panel's Activity page and an app's
// Requests tab: the agent's own audit log (root-only) and Caddy's per-site
// access logs. Both are tails: the newest entries first.
import { join } from "node:path";
import { assertInt, assertSlug } from "@layer/protocol";
import type { ActionTable, Context, Params } from "../context.ts";
import { tailLines } from "../fsutil.ts";

export interface ActivityEntry {
  id: string;
  ts: string;
  action: string;
  params: unknown;
  ok: boolean | null;
  code: string | null;
  ms: number | null;
}

// Reads the panel polls. Logs from before only changes were audited have them.
const READ_ONLY = /\.(info|status|list|history|tail|sample|disk|check|score)$/;

async function auditTail(params: Params, ctx: Context) {
  const limit = assertInt(params.limit ?? 200, "limit", 1, 1000);
  const byId = new Map<string, ActivityEntry>();
  for (const line of tailLines(ctx.paths.auditLog, 2 * 2 ** 20)) {
    let e: { id?: string; ts?: string; action?: string; phase?: string; params?: unknown; ok?: boolean; code?: string; ms?: number };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e.id || !e.action || READ_ONLY.test(e.action)) continue;
    if (e.phase === "start") byId.set(e.id, { id: e.id, ts: e.ts ?? "", action: e.action, params: e.params ?? null, ok: null, code: null, ms: null });
    else if (e.phase === "end") {
      const started = byId.get(e.id);
      if (started) Object.assign(started, { ok: e.ok ?? null, code: e.code ?? null, ms: e.ms ?? null });
    }
  }
  return { entries: [...byId.values()].reverse().slice(0, limit) };
}

export interface RequestEntry {
  at: number;
  status: number;
  method: string;
  host: string;
  uri: string;
  ip: string;
  ms: number;
  bytes: number;
}

async function requestsTail(params: Params, ctx: Context) {
  const slug = assertSlug(params.slug);
  const limit = assertInt(params.limit ?? 200, "limit", 1, 1000);
  const requests: RequestEntry[] = [];
  for (const line of tailLines(join(ctx.paths.caddyLogDir, `${slug}.log`), 2 ** 20)) {
    let e: { ts?: number; status?: number; duration?: number; size?: number; request?: { method?: string; host?: string; uri?: string; remote_ip?: string; client_ip?: string } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e.request || typeof e.ts !== "number") continue;
    requests.push({
      at: Math.round(e.ts * 1000),
      status: e.status ?? 0,
      method: String(e.request.method ?? "").slice(0, 10),
      host: String(e.request.host ?? "").slice(0, 253),
      uri: String(e.request.uri ?? "").slice(0, 500),
      ip: String(e.request.client_ip ?? e.request.remote_ip ?? ""),
      ms: Math.round((e.duration ?? 0) * 1000),
      bytes: e.size ?? 0,
    });
  }
  return { slug, requests: requests.reverse().slice(0, limit) };
}

export const activityActions: ActionTable = {
  "audit.tail": { mutates: false, run: auditTail },
  "requests.tail": { mutates: false, run: requestsTail },
};

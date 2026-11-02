import { isActionName, ValidationError, type Response } from "@layer/protocol";
import { activityActions } from "./actions/activity.ts";
import { browseActions } from "./actions/browse.ts";
import { editActions } from "./actions/edit.ts";
import { appActions } from "./actions/app.ts";
import { buildActions } from "./actions/build.ts";
import { catalogActions } from "./actions/catalog.ts";
import { backupActions } from "./actions/backup.ts";
import { cronActions } from "./actions/cron.ts";
import { firewallActions } from "./actions/firewall.ts";
import { serviceActions } from "./actions/service.ts";
import { envActions } from "./actions/env.ts";
import { logsActions } from "./actions/logs.ts";
import { metricsActions } from "./actions/metrics.ts";
import { panelActions } from "./actions/panel.ts";
import { proxyActions } from "./actions/proxy.ts";
import { repairActions } from "./actions/repair.ts";
import { updateActions } from "./actions/update.ts";
import { releaseActions } from "./actions/release.ts";
import { unitActions } from "./actions/unit.ts";
import { nodeActions } from "./actions/node.ts";
import { staticActions } from "./actions/static.ts";
import { systemActions } from "./actions/system.ts";
import { toolActions } from "./actions/tool.ts";
import type { Audit } from "./audit.ts";
import { NO_IO, type ActionTable, type CallIO, type Context } from "./context.ts";
import { ActionError } from "./errors.ts";
import { KeyedLock, Lock } from "./lock.ts";

export const ACTION_TABLE: ActionTable = {
  ...systemActions,
  ...nodeActions,
  ...appActions,
  ...envActions,
  ...unitActions,
  ...releaseActions,
  ...proxyActions,
  ...logsActions,
  ...buildActions,
  ...catalogActions,
  ...toolActions,
  ...staticActions,
  ...cronActions,
  ...backupActions,
  ...serviceActions,
  ...firewallActions,
  ...panelActions,
  ...repairActions,
  ...updateActions,
  ...metricsActions,
  ...activityActions,
  ...browseActions,
  ...editActions,
};

export const MAX_LINE_BYTES = 1024 * 1024;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

function fail(id: string | null, code: string, message: string): Response {
  return { id, ok: false, error: { code, message } };
}

export interface Dispatcher {
  /** makeIO builds the streaming handle once the request id is known. */
  handleLine(line: string, makeIO?: (id: string) => CallIO): Promise<Response>;
}

export function createDispatcher(ctx: Context, audit: Audit, table: ActionTable = ACTION_TABLE): Dispatcher {
  const locks = { global: new Lock(), build: new KeyedLock() };

  async function handleLine(line: string, makeIO: (id: string) => CallIO = () => NO_IO): Promise<Response> {
    let req: unknown;
    try {
      req = JSON.parse(line);
    } catch {
      return fail(null, "bad_request", "request is not valid JSON");
    }
    if (typeof req !== "object" || req === null || Array.isArray(req)) {
      return fail(null, "bad_request", "request must be a JSON object");
    }
    const { id, action, params = {} } = req as Record<string, unknown>;
    if (typeof id !== "string" || !REQUEST_ID.test(id)) {
      return fail(null, "bad_request", "id must be 1-64 chars of A-Z a-z 0-9 _ -");
    }
    if (!isActionName(action)) {
      return fail(id, "unknown_action", `unknown action: ${String(action).slice(0, 64)}`);
    }
    const def = table[action];
    if (!def) return fail(id, "not_implemented", `${action} is not implemented yet`);
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return fail(id, "invalid_params", "params must be an object");
    }
    const p = params as Record<string, unknown>;

    const started = Date.now();
    // Only what changes the box: status reads (the panel polls every minute) would bury it.
    if (def.mutates) audit.write({ id, action, phase: "start", params: def.redact ? def.redact(p) : p });
    let response: Response;
    try {
      const io = makeIO(id);
      const run = () => def.run(p, ctx, io);
      const result = await (!def.mutates ? run() : def.lock === "build" ? locks.build.run(String(p.slug ?? ""), run) : locks.global.run(run));
      response = { id, ok: true, result };
    } catch (err) {
      if (err instanceof ValidationError) {
        response = fail(id, "invalid_params", err.message);
      } else if (err instanceof ActionError) {
        response = fail(id, err.code, err.message);
      } else {
        // Command output can contain secrets or paths: keep it in the journal only.
        console.error(`[${id}] ${action} failed:`, err);
        response = fail(id, "internal", `${action} failed (details: journalctl -u layer-agent)`);
      }
    }
    if (def.mutates) audit.write({
      id,
      action,
      phase: "end",
      ok: "ok" in response && response.ok,
      // What the caller was told: unexpected errors already say only where to look.
      ...("error" in response ? { code: response.error.code, message: response.error.message } : {}),
      ms: Date.now() - started,
    });
    return response;
  }

  return { handleLine };
}

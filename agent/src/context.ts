import type { ActionName } from "@layer/protocol";
import type { Paths } from "./config.ts";
import type { Exec } from "./exec.ts";

export interface Context {
  paths: Paths;
  exec: Exec;
}

export type Params = Record<string, unknown>;

export interface ActionDef {
  /** Mutating actions run one at a time under the global lock. */
  mutates: boolean;
  run: (params: Params, ctx: Context) => Promise<unknown>;
  /** What the audit log records instead of the raw params (e.g. env keys, never values). */
  redact?: (params: Params) => unknown;
}

export type ActionTable = Partial<Record<ActionName, ActionDef>>;

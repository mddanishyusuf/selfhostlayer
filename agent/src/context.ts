import type { ActionName } from "@layer/protocol";
import type { Paths } from "./config.ts";
import type { Exec } from "./exec.ts";
import type { Spawn } from "./sandbox.ts";

export interface Context {
  paths: Paths;
  exec: Exec;
  /** Streaming runs (builds); exec is for short commands. */
  spawn: Spawn;
}

export type Params = Record<string, unknown>;

/** Per-call streaming: emit sends {id, chunk} frames; signal aborts when the client goes away. */
export interface CallIO {
  emit: (chunk: string) => void;
  signal: AbortSignal;
}

export const NO_IO: CallIO = { emit: () => {}, signal: new AbortController().signal };

export type LockName = "global" | "build";

export interface ActionDef {
  /** Mutating actions run one at a time under a lock: "global" unless `lock` says otherwise. */
  mutates: boolean;
  /**
   * "build" for long-running builds: one build at a time, without holding the
   * global lock, so a 10-minute build never blocks proxy.set or unit.* for
   * other apps.
   */
  lock?: LockName;
  run: (params: Params, ctx: Context, io: CallIO) => Promise<unknown>;
  /** What the audit log records instead of the raw params (e.g. env keys, never values). */
  redact?: (params: Params) => unknown;
}

export type ActionTable = Partial<Record<ActionName, ActionDef>>;

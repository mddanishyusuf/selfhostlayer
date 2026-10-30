// Whether a newer release is out. The monitor asks the agent every 6 hours
// (unless that's turned off in Settings → Version), and so does Check for
// updates. The answer is kept in panel_state, so every page can offer it.
import { agent } from "./agent";
import { boxConfig } from "./box";
import { now } from "./db";
import { readState, writeState } from "./panel-state";

export interface Release {
  version: string;
  date: string | null;
  notes: string | null;
}

export interface UpdateState {
  /** The last check, worked or not. */
  checkedAt: number;
  /** Why the last check failed, if it did; the other fields are from the last one that worked. */
  error: string | null;
  current?: string;
  latest?: Release | null;
  available?: boolean;
}

const KEY = "update-check";
const AUTO = "update-auto-check";
export const UPDATE_CHECK_EVERY_MS = 6 * 3600_000;

export function updateState(): UpdateState | null {
  const raw = readState(KEY);
  return raw ? (JSON.parse(raw) as UpdateState) : null;
}

export async function checkForUpdates(): Promise<UpdateState> {
  let next: UpdateState;
  try {
    const r = await agent<{ current: string; latest: Release | null; available: boolean }>("update.check");
    next = { checkedAt: now(), error: null, current: r.current, latest: r.latest, available: r.available };
  } catch (err) {
    next = { ...updateState(), checkedAt: now(), error: err instanceof Error ? err.message : "the check failed" };
  }
  writeState(KEY, JSON.stringify(next));
  return next;
}

/**
 * The release to offer, if any: newer than this server's version, from a
 * check made on that version (after an update, the old answer no longer counts).
 */
export function offeredUpdate(state: UpdateState | null = updateState(), version = boxConfig().version): Release | null {
  return state?.available && state.latest && state.current === version ? state.latest : null;
}

export const autoCheck = () => readState(AUTO) !== "off";
export const setAutoCheck = (on: boolean) => writeState(AUTO, on ? "on" : "off");

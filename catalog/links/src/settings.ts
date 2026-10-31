// The owner's settings, kept in the settings table (changed from the panel,
// no restart): where the bare domain and unknown slugs go, the redirect type
// new links get, and how many days raw clicks are kept before the daily rollup.
import type { DatabaseSync } from "node:sqlite";
import { getSetting, setSetting } from "./db.ts";
import { checkRedirect, checkTarget, InputError, type Redirect } from "./validate.ts";

export interface Settings {
  /** Where the bare domain goes ("" shows a short page). */
  home: string;
  /** Where unknown slugs go ("" answers 404). */
  missing: string;
  defaultRedirect: Redirect;
  /** Raw clicks older than this become daily totals. */
  keepDays: number;
}

const DEFAULTS: Settings = { home: "", missing: "", defaultRedirect: 302, keepDays: 90 };

export function readSettings(db: DatabaseSync): Settings {
  const json = getSetting(db, "owner");
  return json ? { ...DEFAULTS, ...(JSON.parse(json) as Partial<Settings>) } : { ...DEFAULTS };
}

/** Saves what's given (each field checked), keeps the rest. */
export function saveSettings(db: DatabaseSync, input: Record<string, unknown>): Settings {
  const next = readSettings(db);
  if (input.home !== undefined) next.home = input.home === "" ? "" : checkTarget(input.home, "home");
  if (input.missing !== undefined) next.missing = input.missing === "" ? "" : checkTarget(input.missing, "missing");
  if (input.defaultRedirect !== undefined) next.defaultRedirect = checkRedirect(input.defaultRedirect);
  if (input.keepDays !== undefined) {
    const days = Number(input.keepDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new InputError("keepDays", "must be 1 to 3650 days");
    next.keepDays = days;
  }
  setSetting(db, "owner", JSON.stringify(next));
  return next;
}

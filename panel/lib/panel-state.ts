// Small values the panel keeps between requests, like an address it's
// waiting to move to while the DNS record spreads.
import { db, now } from "./db";

export function readState(key: string): string | null {
  const row = db().prepare("SELECT value FROM panel_state WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function writeState(key: string, value: string): void {
  db()
    .prepare("INSERT INTO panel_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(key, value, now());
}

export function clearState(key: string): void {
  db().prepare("DELETE FROM panel_state WHERE key = ?").run(key);
}

/** The address the panel moves to once its DNS record points here and its certificate is issued. */
export const PANEL_MOVE = "panel-move";

// Email's daily clean-up (cron.js prune): bodies of sent emails go after 30
// days (the logs keep who, what and when), messages and their events after
// 365, as Settings says. Nothing still queued or sending is touched.
import type { DatabaseSync } from "node:sqlite";
import { readSettings } from "./admin.ts";

export function prune(db: DatabaseSync, now = Date.now()): { bodies: number; messages: number } {
  const s = readSettings(db);
  const DAY = 86_400_000;
  const bodies = Number(db.prepare("DELETE FROM message_bodies WHERE message_id IN (SELECT id FROM messages WHERE created_at < ? AND status NOT IN ('queued', 'sending'))").run(now - s.keepBodiesDays * DAY).changes);
  const cutoff = now - s.keepDays * DAY;
  db.prepare("DELETE FROM events WHERE message_id IN (SELECT id FROM messages WHERE created_at < ? AND status NOT IN ('queued', 'sending'))").run(cutoff);
  const messages = Number(db.prepare("DELETE FROM messages WHERE created_at < ? AND status NOT IN ('queued', 'sending')").run(cutoff).changes);
  db.prepare("DELETE FROM idempotency WHERE created_at < ?").run(now - DAY);
  // Shield's log of refusals and flags: 90 days is enough for its page.
  db.prepare("DELETE FROM shield_log WHERE at < ?").run(now - 90 * DAY);
  return { bodies, messages };
}

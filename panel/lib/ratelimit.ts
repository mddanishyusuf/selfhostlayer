import { db, now } from "./db";

// Failed attempts per key (an IP, or an email) inside a sliding window.
const WINDOW_SECONDS = 15 * 60;
export const MAX_FAILURES = 5;

export function isLimited(key: string): boolean {
  const row = db()
    .prepare("SELECT COUNT(*) AS n FROM auth_failures WHERE key = ? AND at > ?")
    .get(key, now() - WINDOW_SECONDS) as { n: number };
  return row.n >= MAX_FAILURES;
}

export function recordFailure(...keys: string[]): void {
  const insert = db().prepare("INSERT INTO auth_failures (key, at) VALUES (?, ?)");
  for (const key of keys) insert.run(key, now());
  db().prepare("DELETE FROM auth_failures WHERE at < ?").run(now() - WINDOW_SECONDS);
}

export function clearFailures(...keys: string[]): void {
  const del = db().prepare("DELETE FROM auth_failures WHERE key = ?");
  for (const key of keys) del.run(key);
}

export const LIMITED_MESSAGE = "Too many attempts. Wait 15 minutes and try again.";

// When is something an incident, and when has it recovered? Pure functions,
// so the thresholds are easy to test. Recovery uses a lower bar than the
// alert (hysteresis), so a value hovering at the limit doesn't flap.

export const DISK_ALERT = 0.8;
export const DISK_RECOVER = 0.75;
export const CERT_MIN_DAYS = 14;
/** A new certificate that still isn't issued after this long is a problem (DNS, rate limits). */
export const CERT_ISSUING_GRACE_SEC = 15 * 60;
export const CRASH_RESTARTS = 3;

export type Verdict = "alert" | "recover" | "unchanged";

export function diskVerdict(usedFraction: number, open: boolean): Verdict {
  if (!open && usedFraction >= DISK_ALERT) return "alert";
  if (open && usedFraction < DISK_RECOVER) return "recover";
  return "unchanged";
}

export interface UnitSnapshot {
  state: string; // ActiveState: active, activating, failed, inactive
  restarts: number; // NRestarts
}

/**
 * A live app is crash-looping when systemd gave up on it (failed), or when it
 * restarted CRASH_RESTARTS+ times since the last check. Recovered when it's
 * active and didn't restart since the last check.
 */
export function crashVerdict(prev: UnitSnapshot | null, now: UnitSnapshot, open: boolean): Verdict {
  const restartedSince = prev ? now.restarts - prev.restarts : 0;
  if (!open && (now.state === "failed" || restartedSince >= CRASH_RESTARTS)) return "alert";
  if (open && now.state === "active" && restartedSince === 0) return "recover";
  return "unchanged";
}

export type CertCheck =
  | { ok: true; daysLeft: number }
  | { ok: false; reason: "issuing" | "untrusted" | "expired" | "unreachable" };

/**
 * Expired, unreachable, renewal not happening (under CERT_MIN_DAYS left) or a
 * new certificate stuck issuing past the grace period: alert. A local-CA
 * certificate (test boxes) is never an incident.
 */
export function certVerdict(check: CertCheck, liveForSec: number, open: boolean): Verdict {
  let bad: boolean;
  if (check.ok) bad = check.daysLeft < CERT_MIN_DAYS;
  else if (check.reason === "untrusted") bad = false;
  else if (check.reason === "issuing") bad = liveForSec > CERT_ISSUING_GRACE_SEC;
  else bad = true;
  if (!open && bad) return "alert";
  if (open && !bad && check.ok) return "recover";
  return "unchanged";
}

/** A cron job's last run (from systemd): alert on a new failed run, recover on a successful one. */
export function cronVerdict(lastResult: string | null, lastRun: string | null, open: boolean): Verdict {
  if (!lastRun || !lastResult) return "unchanged";
  if (!open && lastResult !== "success") return "alert";
  if (open && lastResult === "success") return "recover";
  return "unchanged";
}

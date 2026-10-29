import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { config } from "./config";
import { randomToken, sha256 } from "./crypto";
import { db, now } from "./db";

// __Host- cookies must be Secure, path=/ and host-only: they can't be set by
// a subdomain or over plain HTTP.
export const SESSION_COOKIE = config.isProd ? "__Host-layer_session" : "layer_session";
export const SETUP_COOKIE = config.isProd ? "__Host-layer_setup" : "layer_setup";

const SESSION_DAYS = 7;
const MFA_PENDING_SECONDS = 5 * 60;

export interface User {
  id: number;
  email: string;
}

export interface Session {
  user: User;
  mfaOk: boolean;
}

export async function clientIp(): Promise<string> {
  // The panel is only reachable through Caddy (unix socket), and Caddy replaces
  // X-Forwarded-For with the real client address, so this can't be spoofed.
  const forwarded = (await headers()).get("x-forwarded-for");
  return forwarded?.split(",").at(-1)?.trim() || "local";
}

export const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  secure: config.isProd,
  sameSite: "lax" as const,
  path: "/",
  maxAge,
});

/** Starts a session. Until mfaOk it only allows the 2FA step, for 5 minutes. */
export async function createSession(userId: number, mfaOk: boolean): Promise<void> {
  const token = randomToken();
  const lifetime = mfaOk ? SESSION_DAYS * 86400 : MFA_PENDING_SECONDS;
  const ua = (await headers()).get("user-agent")?.slice(0, 200) ?? null;
  db()
    .prepare("INSERT INTO sessions (id_hash, user_id, mfa_ok, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(sha256(token), userId, mfaOk ? 1 : 0, now(), now() + lifetime, await clientIp(), ua);
  (await cookies()).set(SESSION_COOKIE, token, cookieOptions(lifetime));
}

export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = db()
    .prepare(
      `SELECT s.mfa_ok, u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), now()) as { mfa_ok: number; id: number; email: string } | undefined;
  return row ? { user: { id: row.id, email: row.email }, mfaOk: row.mfa_ok === 1 } : null;
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) db().prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(token));
  jar.delete(SESSION_COOKIE);
}

export interface SessionInfo {
  current: boolean;
  createdAt: number;
  ip: string | null;
  userAgent: string | null;
}

/** The user's signed-in sessions, newest first. */
export async function listSessions(userId: number): Promise<SessionInfo[]> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const mine = token ? sha256(token) : "";
  const rows = db()
    .prepare("SELECT id_hash, created_at, ip, user_agent FROM sessions WHERE user_id = ? AND mfa_ok = 1 AND expires_at > ? ORDER BY created_at DESC")
    .all(userId, now()) as { id_hash: string; created_at: number; ip: string | null; user_agent: string | null }[];
  return rows.map((r) => ({ current: r.id_hash === mine, createdAt: r.created_at, ip: r.ip, userAgent: r.user_agent }));
}

/** Signs out every session of the user except this one. Returns how many ended. */
export async function endOtherSessions(userId: number): Promise<number> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return Number(db().prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?").run(userId, token ? sha256(token) : "").changes);
}

/** For app pages: a fully signed-in user, or a redirect to the right step. */
export async function requireUser(): Promise<User> {
  if (!hasAdmin()) redirect("/setup");
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.mfaOk) redirect("/login/2fa");
  return session.user;
}

export const hasAdmin = () => (db().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n > 0;

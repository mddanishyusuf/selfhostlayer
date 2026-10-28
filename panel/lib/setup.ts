import { cookies } from "next/headers";
import { randomToken, sha256 } from "./crypto";
import { db, now } from "./db";
import { cookieOptions, SETUP_COOKIE } from "./session";

const SETUP_MINUTES = 30;

export interface SetupState {
  email: string | null;
  passwordHash: string | null;
  totpSecretEnc: string | null;
}

/** After a valid setup token: a 30-minute setup session in the browser that entered it. */
export async function startSetup(): Promise<void> {
  const token = randomToken();
  db().prepare("DELETE FROM setup_state").run();
  db().prepare("INSERT INTO setup_state (id, cookie_hash, expires_at) VALUES (1, ?, ?)").run(sha256(token), now() + SETUP_MINUTES * 60);
  (await cookies()).set(SETUP_COOKIE, token, cookieOptions(SETUP_MINUTES * 60));
}

export async function getSetup(): Promise<SetupState | null> {
  const token = (await cookies()).get(SETUP_COOKIE)?.value;
  if (!token) return null;
  const row = db()
    .prepare("SELECT email, password_hash, totp_secret_enc FROM setup_state WHERE id = 1 AND cookie_hash = ? AND expires_at > ?")
    .get(sha256(token), now()) as { email: string | null; password_hash: string | null; totp_secret_enc: string | null } | undefined;
  return row ? { email: row.email, passwordHash: row.password_hash, totpSecretEnc: row.totp_secret_enc } : null;
}

export function saveSetupAccount(email: string, passwordHash: string, totpSecretEnc: string): void {
  db().prepare("UPDATE setup_state SET email = ?, password_hash = ?, totp_secret_enc = ? WHERE id = 1").run(email, passwordHash, totpSecretEnc);
}

export async function endSetup(): Promise<void> {
  db().prepare("DELETE FROM setup_state").run();
  (await cookies()).delete(SETUP_COOKIE);
}

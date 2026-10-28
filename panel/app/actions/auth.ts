"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { decrypt, encrypt, sha256 } from "@/lib/crypto";
import { db, now } from "@/lib/db";
import { dummyPasswordHash, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "@/lib/password";
import { clearFailures, isLimited, LIMITED_MESSAGE, recordFailure } from "@/lib/ratelimit";
import { clientIp, cookieOptions, createSession, endSession, getSession, hasAdmin } from "@/lib/session";
import { endSetup, getSetup, saveSetupAccount, startSetup } from "@/lib/setup";
import { checkSetupToken } from "@/lib/setup-token";
import { generateRecoveryCodes, generateTotpSecret, normalizeRecoveryCode, verifyTotp } from "@/lib/totp";

export interface FormState {
  error?: string;
  email?: string;
}

const RECOVERY_FLASH = "layer_recovery_flash";
const field = (form: FormData, name: string) => String(form.get(name) ?? "");

export async function submitSetupToken(_prev: FormState, form: FormData): Promise<FormState> {
  if (hasAdmin()) redirect("/login");
  const ipKey = `setup:${await clientIp()}`;
  if (isLimited(ipKey)) return { error: LIMITED_MESSAGE };

  const result = checkSetupToken(field(form, "token"));
  if (result !== "ok") {
    recordFailure(ipKey);
    return {
      error: {
        invalid: "That setup token isn't right. Copy it again from the installer output.",
        expired: "This setup token has expired. Re-run the installer on the server to get a new one.",
        missing: "No setup token on this server. Re-run the installer to create one.",
      }[result],
    };
  }
  clearFailures(ipKey);
  await startSetup();
  redirect("/setup/account");
}

export async function submitAccount(_prev: FormState, form: FormData): Promise<FormState> {
  if (!(await getSetup())) redirect("/setup");
  const email = field(form, "email").trim().toLowerCase();
  const password = field(form, "password");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return { error: "Enter a valid email address.", email };
  if (password.length < MIN_PASSWORD_LENGTH) return { error: `Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`, email };
  if (password.length > 256) return { error: "That password is too long (256 characters max).", email };
  if (password !== field(form, "confirm")) return { error: "The two passwords don't match.", email };

  saveSetupAccount(email, await hashPassword(password), encrypt(generateTotpSecret()));
  redirect("/setup/2fa");
}

export async function confirmSetup2fa(_prev: FormState, form: FormData): Promise<FormState> {
  const setup = await getSetup();
  if (!setup?.email || !setup.passwordHash || !setup.totpSecretEnc) redirect("/setup");
  const ipKey = `setup2fa:${await clientIp()}`;
  if (isLimited(ipKey)) return { error: LIMITED_MESSAGE };

  const counter = verifyTotp(decrypt(setup.totpSecretEnc), field(form, "code"));
  if (counter === null) {
    recordFailure(ipKey);
    return { error: "That code didn't match. Check your authenticator app and try the current code." };
  }

  const codes = generateRecoveryCodes();
  const database = db();
  database.exec("BEGIN");
  try {
    const user = database
      .prepare("INSERT INTO users (email, password_hash, totp_secret_enc, totp_last_counter, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(setup.email, setup.passwordHash, setup.totpSecretEnc, counter, now());
    const insert = database.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)");
    for (const code of codes) insert.run(user.lastInsertRowid, sha256(normalizeRecoveryCode(code)));
    database.exec("COMMIT");
    await endSetup();
    await createSession(Number(user.lastInsertRowid), true);
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
  // Shown once on the next page, then gone: only hashes are stored.
  (await cookies()).set(RECOVERY_FLASH, encrypt(JSON.stringify(codes)), cookieOptions(10 * 60));
  redirect("/setup/recovery");
}

export async function readRecoveryFlash(): Promise<string[] | null> {
  const sealed = (await cookies()).get(RECOVERY_FLASH)?.value;
  if (!sealed) return null;
  try {
    return JSON.parse(decrypt(sealed)) as string[];
  } catch {
    return null;
  }
}

export async function finishSetup(): Promise<void> {
  (await cookies()).delete(RECOVERY_FLASH);
  redirect("/");
}

export async function submitLogin(_prev: FormState, form: FormData): Promise<FormState> {
  const email = field(form, "email").trim().toLowerCase();
  const ipKey = `login:${await clientIp()}`;
  const emailKey = `login-email:${email}`;
  if (isLimited(ipKey) || isLimited(emailKey)) return { error: LIMITED_MESSAGE, email };

  const user = db().prepare("SELECT id, password_hash FROM users WHERE email = ?").get(email) as
    | { id: number; password_hash: string }
    | undefined;
  // Hash even for unknown emails, so response time doesn't reveal which exist.
  const ok = await verifyPassword(field(form, "password"), user?.password_hash ?? (await dummyPasswordHash()));
  if (!user || !ok) {
    recordFailure(ipKey, emailKey);
    return { error: "Email or password is incorrect.", email };
  }
  clearFailures(emailKey);
  await createSession(user.id, false);
  redirect("/login/2fa");
}

export async function submitLogin2fa(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.mfaOk) redirect("/");
  const key = `2fa:${session.user.id}`;
  if (isLimited(key)) {
    await endSession();
    return { error: LIMITED_MESSAGE };
  }

  const input = field(form, "code").trim();
  const user = db().prepare("SELECT totp_secret_enc, totp_last_counter FROM users WHERE id = ?").get(session.user.id) as {
    totp_secret_enc: string;
    totp_last_counter: number;
  };
  let ok = false;
  if (/^\d{6}$/.test(input)) {
    const counter = verifyTotp(decrypt(user.totp_secret_enc), input, user.totp_last_counter);
    if (counter !== null) {
      db().prepare("UPDATE users SET totp_last_counter = ? WHERE id = ?").run(counter, session.user.id);
      ok = true;
    }
  } else if (input) {
    const used = db()
      .prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL")
      .run(now(), session.user.id, sha256(normalizeRecoveryCode(input)));
    ok = used.changes === 1;
  }
  if (!ok) {
    recordFailure(key, `login:${await clientIp()}`);
    return { error: "That code didn't work. Use the current code from your app, or a recovery code." };
  }
  clearFailures(key, `login-email:${session.user.email}`);
  await endSession();
  await createSession(session.user.id, true);
  redirect("/");
}

export async function logout(): Promise<void> {
  await endSession();
  redirect("/login");
}

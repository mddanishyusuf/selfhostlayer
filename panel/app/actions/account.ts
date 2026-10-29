"use server";

import { revalidatePath } from "next/cache";
import { sha256 } from "@/lib/crypto";
import { db } from "@/lib/db";
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "@/lib/password";
import { clearFailures, isLimited, LIMITED_MESSAGE, recordFailure } from "@/lib/ratelimit";
import { endOtherSessions, requireUser } from "@/lib/session";
import { generateRecoveryCodes, normalizeRecoveryCode } from "@/lib/totp";

export interface AccountState {
  error?: string;
  ok?: string;
  /** New recovery codes, shown once. */
  codes?: string[];
}

/** The current password, checked with the same limit on wrong guesses as sign-in. */
async function checkPassword(userId: number, password: string): Promise<string | null> {
  const key = `account:${userId}`;
  if (isLimited(key)) return LIMITED_MESSAGE;
  const row = db().prepare("SELECT password_hash FROM users WHERE id = ?").get(userId) as { password_hash: string } | undefined;
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    recordFailure(key);
    return "That isn't your current password.";
  }
  clearFailures(key);
  return null;
}

/** A new password; every other session is signed out. */
export async function changePasswordAction(_prev: AccountState, form: FormData): Promise<AccountState> {
  const user = await requireUser();
  const next = String(form.get("password") ?? "");
  if (next.length < MIN_PASSWORD_LENGTH) return { error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  if (next !== String(form.get("confirm") ?? "")) return { error: "The two new passwords don't match." };
  const wrong = await checkPassword(user.id, String(form.get("current") ?? ""));
  if (wrong) return { error: wrong };
  db().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(next), user.id);
  const ended = await endOtherSessions(user.id);
  revalidatePath("/settings");
  return { ok: `Password changed.${ended ? ` Signed out ${ended} other session${ended === 1 ? "" : "s"}.` : ""}` };
}

/** Replaces the recovery codes (the old ones stop working) and shows the new ones once. */
export async function newRecoveryCodesAction(_prev: AccountState, form: FormData): Promise<AccountState> {
  const user = await requireUser();
  const wrong = await checkPassword(user.id, String(form.get("current") ?? ""));
  if (wrong) return { error: wrong };
  const codes = generateRecoveryCodes();
  const database = db();
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(user.id);
    const insert = database.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)");
    for (const code of codes) insert.run(user.id, sha256(normalizeRecoveryCode(code)));
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
  return { ok: "New recovery codes. The old ones no longer work: save these now, they won't be shown again.", codes };
}

export async function signOutOthersAction(): Promise<void> {
  const user = await requireUser();
  await endOtherSessions(user.id);
  revalidatePath("/settings");
}

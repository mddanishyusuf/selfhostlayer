import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// scrypt N=2^15, r=8: ~32MB and ~100ms per hash, so guessing is slow even
// with the DB in hand.
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 2 ** 20;

export const MIN_PASSWORD_LENGTH = 12;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

/** Format: scrypt$N$r$p$salt$hash (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const key = await derive(password, Buffer.from(salt, "base64url"), Number(n), Number(r), Number(p));
  const expected = Buffer.from(hash, "base64url");
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash to compare against when the email doesn't exist, so timing doesn't reveal it. */
let dummyHash: Promise<string> | null = null;
export const dummyPasswordHash = () => (dummyHash ??= hashPassword(randomBytes(16).toString("hex")));

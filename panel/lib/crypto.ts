import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

/**
 * The 32-byte key that encrypts secrets in the panel DB (TOTP secrets now,
 * env vars later). The installer creates it (root:layer 640); in development a
 * key is generated on first use.
 */
let cachedKey: Buffer | null = null;
function secretKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (!existsSync(config.secretKeyFile)) {
    if (config.isProd) throw new Error(`missing ${config.secretKeyFile} (re-run the installer)`);
    mkdirSync(dirname(config.secretKeyFile), { recursive: true });
    writeFileSync(config.secretKeyFile, randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  const key = Buffer.from(readFileSync(config.secretKeyFile, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error(`${config.secretKeyFile} must hold 32 base64 bytes`);
  return (cachedKey = key);
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, base64url. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function decrypt(sealed: string): string {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || data === undefined) throw new Error("not an encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

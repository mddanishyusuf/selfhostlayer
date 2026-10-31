// Secrets at rest, and signed links, for the catalog apps. Keys and passwords
// are encrypted (AES-256-GCM) under a key made from the app's admin token, so
// the database alone (a backup, the panel's database viewer) doesn't give them
// away. Links an app hands out (an email's unsubscribe link, a form's start
// time) carry an HMAC made with its other secret, so nobody can make one.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export class Secrets {
  readonly #key: Buffer;
  readonly #links: string;

  /** purpose: the app's id, so each app's key is its own (email, forms). */
  constructor(adminToken: string, linkSecret: string, purpose: string) {
    this.#key = Buffer.from(hkdfSync("sha256", adminToken, "", `${purpose}: secrets at rest`, 32));
    this.#links = linkSecret;
  }

  seal(text: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.#key, iv);
    const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
    return `v1.${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url")}`;
  }

  open(sealed: string): string {
    try {
      const raw = Buffer.from(sealed.slice(3), "base64url");
      const d = createDecipheriv("aes-256-gcm", this.#key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
    } catch {
      throw new Error("a secret can't be read with this install's admin token: enter it again");
    }
  }

  /** A short signature of the parts, for a link (22 characters). */
  sign(...parts: string[]): string {
    return createHmac("sha256", this.#links).update(parts.join("\u0000")).digest().subarray(0, 16).toString("base64url");
  }

  verify(signature: string, ...parts: string[]): boolean {
    const want = Buffer.from(this.sign(...parts));
    const given = Buffer.from(signature);
    return given.length === want.length && timingSafeEqual(given, want);
  }
}

/** A random id: 16 base64url characters by default. */
export const newId = (bytes = 12) => randomBytes(bytes).toString("base64url");

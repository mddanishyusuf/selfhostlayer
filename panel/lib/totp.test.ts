import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateRecoveryCodes, otpauthUri, totpAt, verifyTotp } from "./totp";
import { hashPassword, verifyPassword } from "./password";

// RFC 6238 appendix B test vector: the ASCII secret "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP", () => {
  it("matches the RFC 6238 SHA-1 test vectors (last 6 digits)", () => {
    const at = (seconds: number) => totpAt(RFC_SECRET, Math.floor(seconds / 30));
    expect(at(59)).toBe("287082");
    expect(at(1111111109)).toBe("081804");
    expect(at(1111111111)).toBe("050471");
    expect(at(1234567890)).toBe("005924");
    expect(at(2000000000)).toBe("279037");
  });

  it("round-trips base32", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 128, 7]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
  });

  it("accepts ±1 step of clock drift and nothing further", () => {
    const t = 1_700_000_000_000;
    const counter = Math.floor(t / 30_000);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, counter), 0, t)).toBe(counter);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, counter - 1), 0, t)).toBe(counter - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, counter + 1), 0, t)).toBe(counter + 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, counter - 2), 0, t)).toBeNull();
  });

  it("refuses a code that was already used", () => {
    const t = 1_700_000_000_000;
    const counter = Math.floor(t / 30_000);
    const code = totpAt(RFC_SECRET, counter);
    expect(verifyTotp(RFC_SECRET, code, counter, t)).toBeNull();
  });

  it("rejects malformed codes", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5"]) expect(verifyTotp(RFC_SECRET, bad)).toBeNull();
  });

  it("builds an otpauth URI authenticator apps accept", () => {
    expect(otpauthUri("ABC", "me@x.com", "Self Host Layer")).toBe(
      "otpauth://totp/Self%20Host%20Layer%3Ame%40x.com?secret=ABC&issuer=Self+Host+Layer&algorithm=SHA1&digits=6&period=30",
    );
  });

  it("makes distinct, readable recovery codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
  });
});

describe("password hashing", () => {
  it("verifies the right password only", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

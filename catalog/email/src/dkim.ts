// DKIM (RFC 6376) for mail sent over SMTP: rsa-sha256, relaxed/relaxed, over
// the headers that matter. The signature goes on top of the message; the
// domain publishes the public key at <selector>._domainkey.<domain>.
// (Amazon SES signs with its own keys, Easy DKIM, so its mail isn't signed here.)
import { createHash, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

/** The headers signed, in this order, when the message has them. */
const SIGNED = ["from", "to", "cc", "reply-to", "subject", "date", "message-id", "mime-version", "content-type", "list-unsubscribe", "list-unsubscribe-post"];

export function newKeyPair(): { privatePem: string; publicBase64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}

/** The DNS TXT record's value for a public key. */
export const dkimRecord = (publicBase64: string) => `v=DKIM1; k=rsa; p=${publicBase64}`;

function split(message: Buffer): { head: string; body: string } {
  const text = message.toString("latin1");
  const at = text.indexOf("\r\n\r\n");
  return at < 0 ? { head: text, body: "" } : { head: text.slice(0, at + 2), body: text.slice(at + 4) };
}

/** Header fields, unfolded line groups, in order, each as written (name and value). */
function fields(head: string): { name: string; raw: string }[] {
  const out: { name: string; raw: string }[] = [];
  for (const line of head.split("\r\n")) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1]!.raw += `\r\n${line}`;
    else out.push({ name: line.slice(0, line.indexOf(":")).trim().toLowerCase(), raw: line });
  }
  return out;
}

/** Relaxed header canonicalization: lowercase name, unfolded, runs of spaces as one, trimmed. */
function relaxedHeader(raw: string): string {
  const colon = raw.indexOf(":");
  const name = raw.slice(0, colon).trim().toLowerCase();
  const value = raw
    .slice(colon + 1)
    .replace(/\r\n(?=[ \t])/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return `${name}:${value}`;
}

/** Relaxed body canonicalization: runs of spaces as one, none at line ends, no empty lines at the end. */
export function relaxedBody(body: string): string {
  const lines = body.split("\r\n").map((l) => l.replace(/[ \t]+/g, " ").replace(/ $/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length ? `${lines.join("\r\n")}\r\n` : "";
}

const b64 = (data: Buffer) => data.toString("base64");

/** The message with a DKIM-Signature header on top. */
export function dkimSign(message: Buffer, o: { domain: string; selector: string; privateKey: string | KeyObject; now?: number }): Buffer {
  const { head, body } = split(message);
  const present = fields(head);
  const names = SIGNED.filter((n) => present.some((f) => f.name === n));
  const bh = b64(createHash("sha256").update(relaxedBody(body), "latin1").digest());
  const tags = `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${o.domain}; s=${o.selector}; t=${Math.floor((o.now ?? Date.now()) / 1000)}; h=${names.join(":")}; bh=${bh}; b=`;
  const signed = names.map((n) => `${relaxedHeader(present.findLast((f) => f.name === n)!.raw)}\r\n`).join("") + relaxedHeader(`DKIM-Signature: ${tags}`);
  const b = b64(sign("sha256", Buffer.from(signed, "latin1"), o.privateKey));
  // Folded at the tags and inside b= so no line passes 78 columns.
  const folded = `DKIM-Signature: ${tags.replace(/; (?=[a-z]+=)/g, ";\r\n\t")}${(b.match(/.{1,70}/g) ?? []).join("\r\n\t")}`;
  return Buffer.concat([Buffer.from(`${folded}\r\n`, "latin1"), message]);
}

/** Checks a message's DKIM-Signature against a public key (tests, and the panel's test send). */
export function dkimVerify(message: Buffer, publicBase64: string): { ok: boolean; reason?: string } {
  const { head, body } = split(message);
  const all = fields(head);
  const sig = all.find((f) => f.name === "dkim-signature");
  if (!sig) return { ok: false, reason: "no DKIM-Signature" };
  const value = relaxedHeader(sig.raw).slice("dkim-signature:".length);
  const tags = Object.fromEntries(
    value
      .split(";")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => [t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1).replace(/\s+/g, "")]),
  );
  const bh = b64(createHash("sha256").update(relaxedBody(body), "latin1").digest());
  if (bh !== tags.bh) return { ok: false, reason: "the body hash differs" };
  // Each signed name takes the next instance from the bottom.
  const used = new Map<string, number>();
  const lines = String(tags.h)
    .split(":")
    .map((n) => {
      const name = n.toLowerCase();
      const instances = all.filter((f) => f.name === name && f !== sig);
      const k = (used.get(name) ?? 0) + 1;
      used.set(name, k);
      const f = instances[instances.length - k];
      return f ? `${relaxedHeader(f.raw)}\r\n` : "";
    })
    .join("");
  const unsigned = relaxedHeader(sig.raw).replace(/(;\s*b=)[^;]*/, "$1");
  const ok = verify("sha256", Buffer.from(lines + unsigned, "latin1"), createPublicKey({ key: Buffer.from(publicBase64, "base64"), format: "der", type: "spki" }), Buffer.from(String(tags.b), "base64"));
  return ok ? { ok } : { ok, reason: "the signature doesn't match" };
}

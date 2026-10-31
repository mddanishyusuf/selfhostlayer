// Tokens for the public API (/api/v1/links). A token is shown once when it's
// made; only its sha256 is kept, with its first characters to tell it apart.
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { InputError } from "./validate.ts";

export interface TokenInfo {
  id: number;
  name: string;
  /** The start of the token (lk_ab12cd), to recognise it. */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface Row {
  id: number;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
}

const fromRow = (r: Row): TokenInfo => ({ id: r.id, name: r.name, prefix: r.prefix, createdAt: r.created_at, lastUsedAt: r.last_used_at });
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export function createToken(db: DatabaseSync, name: unknown): { token: string; info: TokenInfo } {
  if (typeof name !== "string" || !name.trim() || name.length > 60 || /[\u0000-\u001f]/.test(name)) throw new InputError("name", "must be a name of up to 60 characters");
  if ((db.prepare("SELECT count(*) n FROM tokens").get() as { n: number }).n >= 50) throw new InputError("name", "at most 50 tokens: revoke one first");
  const token = `lk_${randomBytes(24).toString("base64url")}`;
  const now = Date.now();
  const r = db.prepare("INSERT INTO tokens (name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?)").run(name.trim(), hash(token), token.slice(0, 9), now);
  return { token, info: { id: Number(r.lastInsertRowid), name: name.trim(), prefix: token.slice(0, 9), createdAt: now, lastUsedAt: null } };
}

export function listTokens(db: DatabaseSync): TokenInfo[] {
  return (db.prepare("SELECT id, name, prefix, created_at, last_used_at FROM tokens ORDER BY id").all() as unknown as Row[]).map(fromRow);
}

export function revokeToken(db: DatabaseSync, id: number): void {
  if (!Number(db.prepare("DELETE FROM tokens WHERE id = ?").run(id).changes)) throw new InputError("id", "no such token", 404);
}

/** The token's record, its last use noted (at most once a minute). */
export function useToken(db: DatabaseSync, token: string, now = Date.now()): TokenInfo | null {
  const row = db.prepare("SELECT id, name, prefix, created_at, last_used_at FROM tokens WHERE token_hash = ?").get(hash(token)) as Row | undefined;
  if (!row) return null;
  if (!row.last_used_at || now - row.last_used_at > 60_000) db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
  return fromRow(row);
}

import { headers } from "next/headers";

/**
 * The address Caddy saw this request come from, the one the panel's address
 * lock matches (remote_ip): the last X-Forwarded-For entry. Caddy replaces the
 * header, or behind a trusted proxy appends to it, so earlier entries can be
 * anything a client sent.
 */
export async function requesterIp(): Promise<string | null> {
  return (await headers()).get("x-forwarded-for")?.split(",").at(-1)?.trim() || null;
}

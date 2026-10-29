import { headers } from "next/headers";

/**
 * The address Caddy saw this request come from: it replaces any
 * X-Forwarded-For a client sends with the real one.
 */
export async function requesterIp(): Promise<string | null> {
  return (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

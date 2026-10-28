import { headers } from "next/headers";
import { config } from "./config";

/**
 * This panel's public origin, e.g. https://37-27-25-45.sslip.io. Behind Caddy
 * the Host header is the panel's own site address (Caddy only routes that
 * host here) and X-Forwarded-Proto is https; in `next dev` it's http://localhost:3000.
 */
export async function panelOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  const proto = h.get("x-forwarded-proto") ?? (config.isProd ? "https" : "http");
  return `${proto}://${host}`;
}

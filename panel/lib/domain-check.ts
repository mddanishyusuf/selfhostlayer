// Checking a custom domain's DNS and putting it live. The Domains page does it
// (Check again, Keep the proxy), and so does the monitor: a domain added while
// its record was still spreading goes live by itself once DNS points here.
import { boxConfig } from "./box";
import { db } from "./db";
import { canGoLive, checkDomain } from "./dns";
import { applyDomains, getDomain, setDomainProxied, setDomainStatus } from "./domains";
import { getProject } from "./projects";

/**
 * Checks DNS for a domain; once it points here, it goes live (Caddy gets it
 * and requests its certificate). Behind Cloudflare's proxy it goes live only
 * when the owner keeps the proxy (keepProxy, remembered from then on).
 * Returns the explanation when it doesn't.
 */
export async function verifyDomain(domainId: number, keepProxy = false): Promise<{ ok: boolean; message: string }> {
  const domain = getDomain(domainId);
  if (!domain) return { ok: false, message: "That domain was removed." };
  if (keepProxy) setDomainProxied(domain.id, true);
  let result: Awaited<ReturnType<typeof checkDomain>>;
  try {
    result = await checkDomain(domain.host, boxConfig().publicIp);
  } catch {
    setDomainStatus(domain.id, domain.status, "Couldn't reach the public DNS resolvers. Try again.");
    return { ok: false, message: "Couldn't reach the public DNS resolvers." };
  }
  const status = result.verdict.status;
  if (!canGoLive(status, keepProxy || domain.proxied)) {
    // A domain that stopped pointing here stays live until removed; only pending ones wait.
    setDomainStatus(domain.id, domain.status, result.message, status);
    return { ok: false, message: result.message };
  }
  // Pointed straight here again: no longer behind the proxy.
  if (status === "ok" && domain.proxied) setDomainProxied(domain.id, false);
  setDomainStatus(domain.id, "active", null, status);
  const project = getProject(domain.projectId);
  if (project) await applyDomains(project);
  return { ok: true, message: result.message };
}

// When each pending domain was last checked by the monitor (kept across module reloads).
const checked: Map<number, number> = ((globalThis as { layerDomainChecks?: Map<number, number> }).layerDomainChecks ??= new Map());

/** Re-checks pending domains: every 2 minutes in the day after they were added, then every half hour. */
export async function recheckPendingDomains(now = Date.now()): Promise<void> {
  const pending = db().prepare("SELECT id, created_at FROM project_domains WHERE status = 'pending'").all() as { id: number; created_at: number }[];
  for (const d of pending) {
    const every = now - d.created_at * 1000 < 86_400_000 ? 2 * 60_000 : 30 * 60_000;
    if (now - (checked.get(d.id) ?? 0) < every) continue;
    checked.set(d.id, now);
    await verifyDomain(d.id).catch(() => {});
  }
}

"use server";

import { revalidatePath } from "next/cache";
import { boxConfig, freeHost } from "@/lib/box";
import { canGoLive, checkDomain } from "@/lib/dns";
import { addDomain, applyDomains, canRemove, getDomain, hostTaken, listDomains, normalizeHost, removeDomain, setDomainProxied, setDomainStatus } from "@/lib/domains";
import { getProject, getProjectBySlug, setFreeHost } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export interface DomainState {
  error?: string;
  added?: string;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/**
 * Checks DNS for a domain; once it points here, it goes live (Caddy gets it
 * and requests its certificate). Behind Cloudflare's proxy it goes live only
 * when the owner keeps the proxy (keepProxy, remembered from then on).
 * Returns the explanation when it doesn't.
 */
async function verify(domainId: number, keepProxy = false): Promise<{ ok: boolean; message: string }> {
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

export async function addDomainAction(_prev: DomainState, form: FormData): Promise<DomainState> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (!project) return { error: "Project not found." };
  const host = normalizeHost(field(form, "host"));
  if (!host) return { error: "Enter a domain like example.com or app.example.com." };
  if (host.endsWith(".internal") && boxConfig().appsDomain !== "internal") return { error: ".internal names only work on test boxes." };
  if (hostTaken(host)) return { error: `${host} is already added to a project on this server.` };

  const domain = addDomain(project.id, host, "primary");
  const www = `www.${host}`;
  const wantWww = form.get("www") === "on" && !host.startsWith("www.") && !hostTaken(www);
  const redirect = wantWww ? addDomain(project.id, www, "redirect", host) : null;
  await verify(domain.id);
  if (redirect) await verify(redirect.id);
  revalidatePath(`/projects/${project.slug}/domains`);
  return { added: host };
}

export async function verifyDomainAction(form: FormData): Promise<void> {
  await requireUser();
  const id = Number(field(form, "domainId"));
  const domain = getDomain(id);
  const keepProxy = form.get("proxy") === "1";
  await verify(id, keepProxy);
  // Keeping the proxy covers its www redirect too, when that's behind Cloudflare as well.
  if (keepProxy && domain) {
    for (const r of listDomains(domain.projectId).filter((x) => x.redirectTo === domain.host && x.status === "pending" && x.dnsStatus === "cloudflare")) await verify(r.id, true);
  }
  if (domain) {
    const project = getProject(domain.projectId);
    if (project) revalidatePath(`/projects/${project.slug}/domains`);
  }
}

export async function removeDomainAction(form: FormData): Promise<void> {
  await requireUser();
  const domain = getDomain(Number(field(form, "domainId")));
  // The free address can go once another domain is live; the last one a project answers on can't.
  if (!domain || !canRemove(domain)) return;
  removeDomain(domain.id);
  const project = getProject(domain.projectId);
  if (!project) return;
  await applyDomains(project);
  revalidatePath(`/projects/${project.slug}/domains`);
}

/** Puts the project's free address (<app>.<apps domain>) back after it was removed. */
export async function restoreFreeDomainAction(form: FormData): Promise<void> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (!project) return;
  const domains = listDomains(project.id);
  if (domains.some((d) => d.role === "free")) return;
  const host = freeHost(project.slug);
  // A redirect left on that name by moving the apps domain gives way.
  const clash = domains.find((d) => d.host === host);
  if (clash) removeDomain(clash.id);
  addDomain(project.id, host, "free", null, "active");
  setFreeHost(project.id, host);
  await applyDomains(project);
  revalidatePath(`/projects/${project.slug}/domains`);
}

"use server";

import { revalidatePath } from "next/cache";
import { boxConfig, freeHost } from "@/lib/box";
import { isRootDomain } from "@/lib/dns";
import { verifyDomain } from "@/lib/domain-check";
import { addDomain, applyDomains, canRemove, getDomain, hostTaken, listDomains, normalizeHost, removeDomain } from "@/lib/domains";
import { getProject, getProjectBySlug, setFreeHost } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export interface DomainState {
  error?: string;
  added?: string;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();


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
  // www only makes sense in front of a root domain: example.com, not docs.example.com.
  const wantWww = form.get("www") === "on" && isRootDomain(host) && !hostTaken(www);
  const redirect = wantWww ? addDomain(project.id, www, "redirect", host) : null;
  await verifyDomain(domain.id);
  if (redirect) await verifyDomain(redirect.id);
  revalidatePath(`/projects/${project.slug}/domains`);
  return { added: host };
}

export async function verifyDomainAction(form: FormData): Promise<void> {
  await requireUser();
  const id = Number(field(form, "domainId"));
  const domain = getDomain(id);
  const keepProxy = form.get("proxy") === "1";
  await verifyDomain(id, keepProxy);
  // Keeping the proxy covers its www redirect too, when that's behind Cloudflare as well.
  if (keepProxy && domain) {
    for (const r of listDomains(domain.projectId).filter((x) => x.redirectTo === domain.host && x.status === "pending" && x.dnsStatus === "cloudflare")) await verifyDomain(r.id, true);
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

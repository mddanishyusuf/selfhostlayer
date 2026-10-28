"use server";

import { revalidatePath } from "next/cache";
import { boxConfig } from "@/lib/box";
import { checkDomain } from "@/lib/dns";
import { addDomain, applyDomains, getDomain, hostTaken, normalizeHost, removeDomain, setDomainStatus } from "@/lib/domains";
import { getProject, getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export interface DomainState {
  error?: string;
  added?: string;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/**
 * Checks DNS for a domain; once it points here, it goes live (Caddy gets it
 * and requests its certificate). Returns the explanation when it doesn't.
 */
async function verify(domainId: number): Promise<{ ok: boolean; message: string }> {
  const domain = getDomain(domainId);
  if (!domain) return { ok: false, message: "That domain was removed." };
  let result: Awaited<ReturnType<typeof checkDomain>>;
  try {
    result = await checkDomain(domain.host, boxConfig().publicIp);
  } catch {
    setDomainStatus(domain.id, domain.status, "Couldn't reach the public DNS resolvers. Try again.");
    return { ok: false, message: "Couldn't reach the public DNS resolvers." };
  }
  if (result.verdict.status !== "ok") {
    // A domain that stopped pointing here stays live until removed; only pending ones wait.
    setDomainStatus(domain.id, domain.status, result.message);
    return { ok: false, message: result.message };
  }
  setDomainStatus(domain.id, "active", null);
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
  await verify(id);
  if (domain) {
    const project = getProject(domain.projectId);
    if (project) revalidatePath(`/projects/${project.slug}/domains`);
  }
}

export async function removeDomainAction(form: FormData): Promise<void> {
  await requireUser();
  const domain = getDomain(Number(field(form, "domainId")));
  if (!domain || domain.role === "free") return;
  removeDomain(domain.id);
  const project = getProject(domain.projectId);
  if (!project) return;
  await applyDomains(project);
  revalidatePath(`/projects/${project.slug}/domains`);
}

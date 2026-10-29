// A project's domains: the free host, custom domains and redirect hosts.
// Only active ones are served; a custom domain becomes active once public DNS
// points it at this server.
import { agent } from "./agent";
import { db, now } from "./db";
import type { Project } from "./projects";

export interface ProjectDomain {
  id: number;
  projectId: number;
  host: string;
  role: "free" | "primary" | "redirect";
  redirectTo: string | null;
  status: "pending" | "active";
  message: string | null;
  /** When DNS was verified (seconds). */
  verifiedAt: number | null;
  /** Served through Cloudflare's proxy (orange cloud), as the owner chose. */
  proxied: boolean;
  /** What the last DNS check found (a DnsVerdict status), or null before the first. */
  dnsStatus: string | null;
}

interface Row {
  id: number;
  project_id: number;
  host: string;
  role: ProjectDomain["role"];
  redirect_to: string | null;
  status: ProjectDomain["status"];
  message: string | null;
  verified_at: number | null;
  proxied: number;
  dns_status: string | null;
}

const fromRow = (r: Row): ProjectDomain => ({
  id: r.id,
  projectId: r.project_id,
  host: r.host,
  role: r.role,
  redirectTo: r.redirect_to,
  status: r.status,
  message: r.message,
  verifiedAt: r.verified_at,
  proxied: r.proxied === 1,
  dnsStatus: r.dns_status,
});

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** Lowercases and checks a hostname someone typed (strips https:// and paths). */
export function normalizeHost(input: string): string | null {
  const host = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
  return HOST.test(host) ? host : null;
}

export function listDomains(projectId: number): ProjectDomain[] {
  return (db().prepare("SELECT * FROM project_domains WHERE project_id = ? ORDER BY role = 'free', created_at").all(projectId) as unknown as Row[]).map(fromRow);
}

/** Every project's domains, with the project's slug: custom ones first. */
export function listAllDomains(): (ProjectDomain & { slug: string })[] {
  const rows = db().prepare("SELECT d.*, p.slug FROM project_domains d JOIN projects p ON p.id = d.project_id ORDER BY d.role = 'free', p.slug, d.created_at").all() as unknown as (Row & { slug: string })[];
  return rows.map((r) => ({ ...fromRow(r), slug: r.slug }));
}

export function getDomain(id: number): ProjectDomain | null {
  const row = db().prepare("SELECT * FROM project_domains WHERE id = ?").get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

export const hostTaken = (host: string) => !!db().prepare("SELECT 1 FROM project_domains WHERE host = ?").get(host);

export function addDomain(projectId: number, host: string, role: "free" | "primary" | "redirect", redirectTo: string | null = null, status: "pending" | "active" = "pending"): ProjectDomain {
  const r = db()
    .prepare("INSERT INTO project_domains (project_id, host, role, redirect_to, status, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(projectId, host, role, redirectTo, status, now(), status === "active" ? now() : null);
  return getDomain(Number(r.lastInsertRowid))!;
}

export function setDomainStatus(id: number, status: "pending" | "active", message: string | null, dnsStatus?: string): void {
  db()
    .prepare("UPDATE project_domains SET status = ?, message = ?, dns_status = coalesce(?, dns_status), verified_at = CASE WHEN ? = 'active' THEN ? ELSE verified_at END WHERE id = ?")
    .run(status, message, dnsStatus ?? null, status, now(), id);
}

export function setDomainProxied(id: number, proxied: boolean): void {
  db().prepare("UPDATE project_domains SET proxied = ? WHERE id = ?").run(proxied ? 1 : 0, id);
}

export function removeDomain(id: number): void {
  // Redirects pointing at a removed domain go with it.
  const d = getDomain(id);
  if (!d) return;
  db().prepare("DELETE FROM project_domains WHERE id = ? OR (project_id = ? AND redirect_to = ?)").run(id, d.projectId, d.host);
}

/** The domains a project answers on itself: active, and not redirects. */
export const servingDomains = (projectId: number): ProjectDomain[] => listDomains(projectId).filter((d) => d.status === "active" && d.role !== "redirect");

/** Whether a domain can go: any, except the last one the project answers on (it would stop being reachable). */
export function canRemove(d: ProjectDomain): boolean {
  const serving = servingDomains(d.projectId);
  return !(serving.length === 1 && serving[0]!.id === d.id);
}

/** What Caddy should serve: active free and primary hosts, plus active redirects to them. */
export function servingConfig(projectId: number): { domains: string[]; redirects: { from: string; to: string }[] } {
  const active = listDomains(projectId).filter((d) => d.status === "active");
  const domains = active.filter((d) => d.role !== "redirect").map((d) => d.host);
  const redirects = active.filter((d) => d.role === "redirect" && d.redirectTo && domains.includes(d.redirectTo)).map((d) => ({ from: d.host, to: d.redirectTo! }));
  return { domains, redirects };
}

/**
 * Pushes the current domains to Caddy for a live project, without a deploy.
 * Does nothing before the first deploy (the deploy applies them).
 */
export async function applyDomains(project: Project): Promise<void> {
  const { domains, redirects } = servingConfig(project.id);
  if (domains.length === 0) return;
  if (project.runtime.kind === "static") {
    await agent("proxy.set", { slug: project.slug, domains, redirects, static: true, spa: project.runtime.spa }).catch((err) => {
      if (!/no published static site/.test(String(err))) throw err;
    });
    return;
  }
  const status = await agent<{ live: "blue" | "green" | null }>("unit.status", { slug: project.slug }).catch(() => ({ live: null }));
  if (!status.live) return;
  await agent("proxy.set", { slug: project.slug, domains, redirects, color: status.live });
}

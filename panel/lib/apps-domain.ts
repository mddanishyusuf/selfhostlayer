// Moving every app's free URL (<slug>.<appsDomain>) to a new apps domain.
// The old URL becomes a redirect, so links and bookmarks keep working.
import { addDomain, applyDomains, listDomains } from "./domains";
import { db } from "./db";
import { listProjects, setFreeHost } from "./projects";

/** Returns how many live sites were updated (the rest get the new URL with their next deploy). */
export async function moveFreeUrls(from: string, to: string): Promise<{ moved: number; failed: string[] }> {
  let moved = 0;
  const failed: string[] = [];
  // This server's apps only: another server has its own apps domain.
  for (const project of listProjects().filter((p) => p.serverId === null)) {
    const domains = listDomains(project.id);
    const free = domains.find((d) => d.role === "free");
    const next = `${project.slug}.${to}`;
    if (!free || free.host === next) continue;
    // Moving back: the URL being returned to is a redirect from the last move.
    db().prepare("DELETE FROM project_domains WHERE project_id = ? AND host = ? AND role = 'redirect'").run(project.id, next);
    db().prepare("UPDATE project_domains SET host = ? WHERE id = ?").run(next, free.id);
    setFreeHost(project.id, next);
    const old = `${project.slug}.${from}`;
    if (!domains.some((d) => d.host === old && d.role === "redirect")) addDomain(project.id, old, "redirect", next, "active");
    try {
      await applyDomains({ ...project, domains: [next, ...project.domains.slice(1)] });
      moved++;
    } catch {
      failed.push(project.slug);
    }
  }
  return { moved, failed };
}

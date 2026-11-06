// Moving a project to another server (PLAN-SERVERS.md, Day 5): it's made and
// deployed there, its data (files and databases) copied from a snapshot, its
// free address moved to that server's, and its own domains wait for DNS to
// point at the new IP. The old copy keeps running until the owner removes it,
// so nothing is down while DNS changes. GitHub projects only for now: a site's
// state also lives in the agent's /etc/layer there.
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agent } from "./agent";
import { config } from "./config";
import { db } from "./db";
import { activeDeployment, deployProject, getDeployment, type Deployment } from "./deploy";
import { listDomains } from "./domains";
import { getProject, setFreeHost, type Project } from "./projects";
import { fetchStaged, freeHostOn, getServer, onServer, putFile } from "./servers";

const STAGING_DIR = "/var/lib/layer-staging";

/** Where a project came from, until its old copy is removed. */
export function movedFrom(projectId: number): number | null | undefined {
  const r = db().prepare("SELECT moved_from FROM project_moves WHERE project_id = ?").get(projectId) as { moved_from: number | null } | undefined;
  return r ? r.moved_from : undefined;
}

type Services = { redis?: unknown; postgres?: unknown; mysql?: unknown; mongodb?: unknown; installed: Record<string, boolean> };

async function waitForDeploy(id: number): Promise<Deployment> {
  for (;;) {
    const d = getDeployment(id)!;
    if (d.status === "ready" || d.status === "failed" || d.status === "cancelled") return d;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Moves a project to a server (null: the panel's own). Returns what happened,
 * step by step, for the page. Throws with the step that failed; until the
 * project's server is switched, nothing about it changes.
 */
export async function moveProject(project: Project, target: number | null, log: (line: string) => void): Promise<void> {
  if (project.source !== "github") throw new Error("Only projects from GitHub can move for now: a site keeps settings on its server.");
  if (project.serverId === target) throw new Error("It's on that server already.");
  if (target !== null && !getServer(target)?.seenAt) throw new Error("Check the connection to that server first.");
  if (activeDeployment(project.id)) throw new Error("A deploy is running: wait for it first.");
  if (movedFrom(project.id) !== undefined) throw new Error("Remove the copy from its last move first.");
  const from = project.serverId;

  // 1. Its databases and Redis, as it has them now.
  const services = await agent<Services>("service.status", { slug: project.slug });
  log(`Making ${project.slug} on the new server, with ${["redis", "postgres", "mysql", "mongodb"].filter((k) => (services as Record<string, unknown>)[k]).join(", ") || "no databases"}…\n`);
  await onServer(target, async () => {
    await agent("app.create", { slug: project.slug }, { server: target });
    for (const kind of ["redis", "postgres", "mysql", "mongodb"] as const) {
      if (!(services as Record<string, unknown>)[kind]) continue;
      await agent("service.install", { name: kind }, { server: target });
      await agent(`${kind}.add` as const, kind === "redis" ? { slug: project.slug, memoryMb: 64 } : { slug: project.slug }, { server: target });
    }
  });

  // 2. The switch: from here on it's the new server's project (its calls go there).
  const free = freeHostOn(project.slug, target);
  const before = { free: project.domains[0]!, statuses: listDomains(project.id).map((d) => ({ id: d.id, status: d.status })) };
  const undo = () => {
    db().prepare("UPDATE projects SET server_id = ? WHERE id = ?").run(from, project.id);
    const f = listDomains(project.id).find((d) => d.role === "free");
    if (f) db().prepare("UPDATE project_domains SET host = ? WHERE id = ?").run(before.free, f.id);
    setFreeHost(project.id, before.free);
    for (const s of before.statuses) db().prepare("UPDATE project_domains SET status = ? WHERE id = ?").run(s.status, s.id);
    db().prepare("DELETE FROM project_moves WHERE project_id = ?").run(project.id);
  };
  db().prepare("INSERT INTO project_moves (project_id, moved_from, at) VALUES (?, ?, ?)").run(project.id, from, Date.now());
  db().prepare("UPDATE projects SET server_id = ? WHERE id = ?").run(target, project.id);
  const oldFree = listDomains(project.id).find((d) => d.role === "free");
  if (oldFree) db().prepare("UPDATE project_domains SET host = ? WHERE id = ?").run(free, oldFree.id);
  setFreeHost(project.id, free);
  // Its own domains wait for DNS to point at the new server (the monitor rechecks them).
  db().prepare("UPDATE project_domains SET status = 'pending', verified_at = NULL WHERE project_id = ? AND role != 'free'").run(project.id);

  // 3. Built and started there.
  log("Deploying it there…\n");
  let done: Deployment;
  try {
    done = await waitForDeploy((await deployProject(getProject(project.id)!, "manual")).id);
  } catch (err) {
    undo();
    throw err;
  }
  if (done.status !== "ready") {
    undo();
    throw new Error(`the deploy there failed: ${done.error ?? done.status} (its log is on the Deployments page). It's back on its old server, which kept running.`);
  }

  // 4. Its data: a snapshot on the old server, restored on the new one.
  log("Copying its data (files and databases)…\n");
  const snap = await agent<{ file: string }>("backup.snapshot", { slug: project.slug }, { server: from });
  const dir = join(config.dataDir, "fetched");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const local = from === null ? join(STAGING_DIR, snap.file) : join(dir, snap.file);
  try {
    if (from !== null) await fetchStaged(from, snap.file, local);
    const name = `${project.slug}-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}.tar.gz`;
    if (target !== null) await putFile(target, local, name);
    else {
      // To the panel's own server: its restore folder is the panel's.
      const restore = join(config.dataDir, "restore");
      mkdirSync(restore, { recursive: true, mode: 0o700 });
      const { copyFileSync } = await import("node:fs");
      copyFileSync(local, join(restore, name));
    }
    await agent("backup.restore", { slug: project.slug, file: name }, { server: target });
  } finally {
    await agent("backup.discard", { file: snap.file }, { server: from }).catch(() => {});
    if (from !== null) rmSync(local, { force: true });
  }
  log(`Moved. It answers at https://${free}; point its own domains at the new server, then remove the old copy.\n`);
}

/** The old copy, after a move: stopped and removed there (its data archived), once its domains point at the new server. */
export async function removeOldCopy(project: Project): Promise<void> {
  const from = movedFrom(project.id);
  if (from === undefined) throw new Error("There's no old copy.");
  await agent("app.delete", { slug: project.slug, keepData: true }, { server: from }).catch((err: Error & { code?: string }) => {
    if (err.code !== "not_found") throw err;
  });
  db().prepare("DELETE FROM project_moves WHERE project_id = ?").run(project.id);
}

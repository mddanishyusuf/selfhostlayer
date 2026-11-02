"use server";

import { revalidatePath } from "next/cache";
import { backUpBeforeEdit, canBackUpEdits, recentBackup } from "@/lib/backup/runner";
import { countRows, parseDb, updateRows, type EditTarget } from "@/lib/browse";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";

// Editing rows in the database viewer: a preview says how many rows change
// and how the app gets backed up first; applying takes that backup (or
// reuses one from the last ten minutes), then has the agent update exactly
// the previewed number of rows in one transaction.

export interface EditInput {
  slug: string;
  /** The viewer's db= value: "postgres", "mysql" or "sqlite:<file>". */
  db: string;
  table: string;
  target: EditTarget;
}

/** How the change will be backed up: a fresh backup, one from minutes ago, or none (no bucket connected). */
export type BackupPlan = { kind: "new" } | { kind: "recent"; at: number } | { kind: "none" };

export type PreviewResult = { ok: true; matches: number; backup: BackupPlan } | { ok: false; error: string };
export type ApplyResult = { ok: true; updated: number; backupId: number | null } | { ok: false; error: string };

function resolve(input: EditInput) {
  const project = getProjectBySlug(input.slug);
  if (!project) throw new Error("Project not found.");
  const target = parseDb(input.db);
  if (!target || (target.engine !== "sqlite" && target.engine !== "postgres" && target.engine !== "mysql")) throw new Error("Only SQLite, Postgres and MySQL tables can be edited.");
  if (target.engine === "sqlite" && !target.file) throw new Error("Pick a SQLite database first.");
  return { project, req: { engine: target.engine, file: target.file, table: input.table, target: input.target } };
}

const message = (err: unknown) => (err instanceof Error ? err.message : "The server refused this change.");

export async function previewEditAction(input: EditInput): Promise<PreviewResult> {
  await requireUser();
  try {
    const { project, req } = resolve(input);
    const { matches } = await countRows(project.slug, req);
    const recent = canBackUpEdits() ? recentBackup(project.slug) : null;
    const backup: BackupPlan = !canBackUpEdits() ? { kind: "none" } : recent ? { kind: "recent", at: recent.finishedAt ?? recent.startedAt } : { kind: "new" };
    return { ok: true, matches, backup };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

export async function applyEditAction(input: EditInput & { set: { column: string; value: string | null }[]; expect: number; withoutBackup?: boolean }): Promise<ApplyResult> {
  await requireUser();
  try {
    const { project, req } = resolve(input);
    // No bucket connected: only with the user's explicit go-ahead, since nothing can undo it.
    if (!canBackUpEdits() && !input.withoutBackup) return { ok: false, error: "Connect backup storage first (Server → Backups), or confirm the change without a backup." };
    const backup = canBackUpEdits() ? await backUpBeforeEdit(project) : null;
    const { updated } = await updateRows(project.slug, { ...req, set: input.set, expect: input.expect });
    revalidatePath(`/projects/${project.slug}/databases/view`);
    revalidatePath(`/projects/${project.slug}/backups`);
    return { ok: true, updated, backupId: backup?.id ?? null };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

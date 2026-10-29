"use server";

import { revalidatePath } from "next/cache";
import { confirmRecoveryKey, getBackupSettings, parseDestination, saveDestination, saveSchedule, testDestination } from "@/lib/backup/settings";
import { backUpEverything, backUpProject, getBackup, restoreBackup } from "@/lib/backup/runner";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export interface DestinationState {
  error?: string;
  ok?: string;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

export async function saveDestinationAction(_prev: DestinationState, form: FormData): Promise<DestinationState> {
  await requireUser();
  const current = getBackupSettings();
  const parsed = parseDestination({
    provider: field(form, "provider"),
    endpoint: field(form, "endpoint"),
    region: field(form, "region"),
    bucket: field(form, "bucket"),
    accessKeyId: field(form, "accessKeyId"),
    // Left empty when changing other fields: keep the saved secret.
    secretAccessKey: field(form, "secretAccessKey") || current?.destination.secretAccessKey || "",
    prefix: field(form, "prefix"),
  });
  if (!parsed.ok) return { error: parsed.error };
  // Only save what demonstrably works.
  const problem = await testDestination(parsed.destination);
  if (problem) return { error: `The storage said no: ${problem}` };
  saveDestination(parsed.provider, parsed.destination);
  revalidatePath("/settings/backups");
  return { ok: "Connected. A test file was written, read back and deleted." };
}

export async function testDestinationAction(): Promise<DestinationState> {
  await requireUser();
  const settings = getBackupSettings();
  if (!settings) return { error: "No storage is set up." };
  const problem = await testDestination(settings.destination);
  return problem ? { error: problem } : { ok: "Connection works." };
}

export async function confirmRecoveryKeyAction(form: FormData): Promise<void> {
  await requireUser();
  if (form.get("saved") !== "on") return;
  confirmRecoveryKey();
  revalidatePath("/settings/backups");
}

export async function saveScheduleAction(form: FormData): Promise<void> {
  await requireUser();
  saveSchedule(Number(field(form, "hour")), Number(field(form, "keep")));
  revalidatePath("/settings/backups");
}

export async function backUpProjectAction(form: FormData): Promise<void> {
  await requireUser();
  const project = getProjectBySlug(field(form, "slug"));
  if (!project) return;
  // In the background: the page shows it running and refreshes.
  void backUpProject(project, "manual").catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
  revalidatePath(`/projects/${project.slug}/backups`);
}

export async function backUpEverythingAction(): Promise<void> {
  await requireUser();
  void backUpEverything("manual").catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
  revalidatePath("/settings/backups");
}

export interface RestoreState {
  error?: string;
  ok?: string;
}

export async function restoreBackupAction(_prev: RestoreState, form: FormData): Promise<RestoreState> {
  await requireUser();
  const backup = getBackup(Number(field(form, "id")));
  if (!backup) return { error: "That backup doesn't exist." };
  if (field(form, "confirm") !== backup.slug) return { error: `Type ${backup.slug} to confirm.` };
  try {
    const { previous } = await restoreBackup(backup.id);
    revalidatePath(`/projects/${backup.slug}/backups`);
    return { ok: `Restored. The app restarted on the backup's data; what it replaced is kept in ${previous}.` };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

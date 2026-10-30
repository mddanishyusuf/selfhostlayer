"use server";

import { revalidatePath } from "next/cache";
import { agent } from "@/lib/agent";
import { requireUser } from "@/lib/session";
import { checkForUpdates, setAutoCheck } from "@/lib/updates";

/** Checks the release feed now; the sidebar and Settings show the answer. */
export async function checkUpdatesAction(): Promise<void> {
  await requireUser();
  await checkForUpdates();
  revalidatePath("/", "layout");
}

export async function setAutoCheckAction(on: boolean): Promise<void> {
  await requireUser();
  setAutoCheck(on);
  revalidatePath("/settings");
}

/** Starts the update; the page then follows /api/update while the panel restarts. */
export async function startUpdateAction(version: string): Promise<{ to?: string; error?: string }> {
  await requireUser();
  try {
    const started = await agent<{ to: string }>("update.start", { version });
    return { to: started.to };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The update didn't start." };
  }
}

export interface RepairResult {
  checked?: number;
  restored?: string[];
  restarted?: string[];
  error?: string;
}

export async function repairAction(): Promise<RepairResult> {
  await requireUser();
  try {
    return await agent<RepairResult>("system.repair");
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Repair failed." };
  }
}

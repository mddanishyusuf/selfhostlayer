"use server";

import { agent } from "@/lib/agent";
import { requireUser } from "@/lib/session";

export interface UpdateCheck {
  current?: string;
  latest?: { version: string; date: string | null; notes: string | null } | null;
  available?: boolean;
  running?: boolean;
  error?: string;
}

export async function checkUpdatesAction(): Promise<UpdateCheck> {
  await requireUser();
  try {
    return await agent<UpdateCheck>("update.check");
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't check for updates." };
  }
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

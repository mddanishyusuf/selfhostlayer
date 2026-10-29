"use server";

import { revalidatePath } from "next/cache";
import { resumeDeployments } from "@/lib/deploy";
import { BUILD_SLOTS, writeState } from "@/lib/panel-state";
import { requireUser } from "@/lib/session";

export interface BuildSlotsState {
  ok?: string;
  error?: string;
}

/** How many projects may build at once; more slots start waiting deployments right away. */
export async function setBuildSlotsAction(_prev: BuildSlotsState, form: FormData): Promise<BuildSlotsState> {
  await requireUser();
  const slots = Number(form.get("slots"));
  if (!Number.isInteger(slots) || slots < 1 || slots > 4) return { error: "Pick 1 to 4." };
  writeState(BUILD_SLOTS, String(slots));
  resumeDeployments();
  revalidatePath("/settings");
  return { ok: slots === 1 ? "Saved: one build at a time." : `Saved: up to ${slots} builds at the same time.` };
}

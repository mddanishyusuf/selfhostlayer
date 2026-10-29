"use server";

import { revalidatePath } from "next/cache";
import { agent } from "@/lib/agent";
import { inRanges, TAILSCALE_RANGES, validRange } from "@/lib/ip";
import { requesterIp } from "@/lib/request";
import { requireUser } from "@/lib/session";

export interface AccessState {
  error?: string;
  saved?: string;
}

/**
 * Who may open the panel. A list that leaves out the address you're using
 * now is refused: it would lock you out (`layer access reset` is the way back).
 */
export async function saveAccessAction(_prev: AccessState, form: FormData): Promise<AccessState> {
  await requireUser();
  const mode = String(form.get("mode") ?? "");
  let allow: string[] = [];
  if (mode === "ips") {
    allow = [...new Set(String(form.get("ips") ?? "").split(/[\s,]+/).filter(Boolean))];
    if (!allow.length) return { error: "Add at least one address, or choose Anyone." };
    const bad = allow.find((r) => !validRange(r));
    if (bad) return { error: `"${bad}" isn't an IP address or a range like 203.0.113.0/24.` };
    if (allow.length > 50) return { error: "At most 50 addresses." };
  } else if (mode === "tailscale") {
    allow = TAILSCALE_RANGES;
  } else if (mode !== "anyone") {
    return { error: "Choose who may open the panel." };
  }
  if (allow.length) {
    const you = await requesterIp();
    if (!you) return { error: "Can't tell which address you're using, so this could lock you out." };
    if (!inRanges(you, allow)) {
      return { error: mode === "tailscale" ? `Open the panel over Tailscale first: you're on ${you} now.` : `Your address (${you}) isn't in the list, so you'd be locked out. Add it first.` };
    }
  }
  await agent("panel.access", { allow });
  revalidatePath("/settings");
  if (!allow.length) return { saved: "Anyone can reach the sign-in page again." };
  const who = mode === "tailscale" ? "Only devices on your tailnet" : `Only ${allow.length === 1 ? "that address" : `those ${allow.length} addresses`}`;
  return { saved: `${who} can open the panel now. GitHub's webhook still gets through. Locked out? Run layer access reset on the server.` };
}

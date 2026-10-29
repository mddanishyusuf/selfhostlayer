"use server";

import { agent, type SystemInfo } from "@/lib/agent";
import { listProjects } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export interface ServerStats {
  info: SystemInfo | null;
  apps: { slug: string; memoryMb: number | null }[];
}

interface UnitStatus {
  live: "blue" | "green" | null;
  blue?: { memoryMb: number | null };
  green?: { memoryMb: number | null };
}

/** For the server modal: the box, and how much memory each app's live process uses. */
export async function serverStats(): Promise<ServerStats> {
  await requireUser();
  const info = await agent<SystemInfo>("system.info").catch(() => null);
  const apps = await Promise.all(
    listProjects()
      .filter((p) => p.runtime.kind !== "static")
      .map(async (p) => {
        try {
          const s = await agent<UnitStatus>("unit.status", { slug: p.slug });
          return { slug: p.slug, memoryMb: (s.live && s[s.live]?.memoryMb) ?? null };
        } catch {
          return { slug: p.slug, memoryMb: null };
        }
      }),
  );
  apps.sort((a, b) => (b.memoryMb ?? -1) - (a.memoryMb ?? -1));
  return { info, apps };
}

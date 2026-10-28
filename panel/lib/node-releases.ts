import { releasesFromIndex, resolveNodeVersion, type NodeRelease } from "./node-version";

let cache: { at: number; releases: NodeRelease[] } | null = null;

/** Node's release index, cached for an hour. */
export async function nodeReleases(): Promise<NodeRelease[]> {
  if (cache && Date.now() - cache.at < 3600_000) return cache.releases;
  const res = await fetch("https://nodejs.org/dist/index.json", { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`nodejs.org answered HTTP ${res.status}`);
  cache = { at: Date.now(), releases: releasesFromIndex(await res.json()) };
  return cache.releases;
}

/**
 * The exact Node version for a project: what it asks for, resolved to the
 * newest matching LTS; the server's default when it asks for nothing (or the
 * index can't be reached).
 */
export async function pickNodeVersion(range: string | null, fallback: string): Promise<{ version: string; warning?: string }> {
  if (!range) return { version: fallback };
  try {
    const version = resolveNodeVersion(range, await nodeReleases());
    if (version) return { version };
    return { version: fallback, warning: `No Node release matches "${range}", so Node ${fallback} is used.` };
  } catch {
    return { version: fallback, warning: `Couldn't reach nodejs.org to resolve "${range}", so Node ${fallback} is used.` };
  }
}

// The repositories the GitHub App can see, for the New project picker. The
// whole list is fetched once (every installation, pages in parallel) and kept
// for five minutes, then refreshed in the background, so searching and
// scrolling never wait on GitHub.
import { listInstallationRepos } from "./github";
import { getApp, listInstallations } from "./github-store";

export interface PickerRepo {
  fullName: string;
  private: boolean;
  pushedAt: string | null;
  branch: string;
  installationId: number;
}

export interface RepoPage {
  repos: PickerRepo[];
  /** Every repository the app can see. */
  total: number;
  /** How many match the search. */
  matches: number;
  /** Where the next page starts, or null at the end. */
  next: number | null;
}

const FRESH_MS = 5 * 60_000;

interface Cache {
  repos: PickerRepo[] | null;
  at: number;
  loading: Promise<PickerRepo[]> | null;
  /** Bumped when GitHub access changes, so a load started before it isn't kept. */
  generation: number;
}
// On globalThis: Next loads modules more than once, and the list must be shared.
const cache: Cache = ((globalThis as { layerRepos?: Cache }).layerRepos ??= { repos: null, at: 0, loading: null, generation: 0 });

async function fetchAll(): Promise<PickerRepo[]> {
  const app = getApp();
  if (!app) return [];
  const lists = await Promise.all(
    listInstallations()
      .filter((i) => !i.suspended)
      .map(async (i) =>
        (await listInstallationRepos(app.credentials, i.id)).map((r) => ({ fullName: r.full_name, private: r.private, pushedAt: r.pushed_at, branch: r.default_branch, installationId: i.id })),
      ),
  );
  return lists.flat().sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
}

/** The list, most recently pushed first. A stale list comes back at once while a fresh one loads. */
export function allRepos(): Promise<PickerRepo[]> {
  if (cache.repos && Date.now() - cache.at < FRESH_MS) return Promise.resolve(cache.repos);
  if (!cache.loading) {
    const generation = cache.generation;
    cache.loading = fetchAll()
      .then((repos) => {
        if (generation === cache.generation) {
          cache.repos = repos;
          cache.at = Date.now();
        }
        return repos;
      })
      .finally(() => {
        cache.loading = null;
      });
    // A background refresh that fails keeps the old list.
    if (cache.repos) cache.loading.catch(() => {});
  }
  return cache.repos ? Promise.resolve(cache.repos) : cache.loading;
}

/** After GitHub access changes: an installation, or repositories added to or removed from one. */
export function forgetRepos(): void {
  cache.repos = null;
  cache.at = 0;
  cache.generation++;
}

/** One page of the list, filtered by a search anywhere in owner/name, ignoring case. */
export function pageOf(all: PickerRepo[], query: string, offset: number, limit: number): RepoPage {
  const term = query.trim().toLowerCase();
  const matching = term ? all.filter((r) => r.fullName.toLowerCase().includes(term)) : all;
  return { repos: matching.slice(offset, offset + limit), total: all.length, matches: matching.length, next: offset + limit < matching.length ? offset + limit : null };
}

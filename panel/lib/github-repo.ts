// Reading a repository: the files detection needs and the latest commit.
// Works with an installation token, or without one for public repos.
import { FILES_TO_CHECK, FILES_TO_READ, type ProjectFiles } from "./detect";
import { GITHUB_API } from "./github";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** "https://github.com/acme/shop", "github.com/acme/shop.git" or "acme/shop" → { owner, repo }. */
export function parseRepoUrl(input: string): { owner: string; repo: string } | null {
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/.exec(input.trim());
  if (!m || !OWNER.test(m[1]!) || !REPO.test(m[2]!) || m[2] === "." || m[2] === "..") return null;
  return { owner: m[1]!, repo: m[2]! };
}

async function api<T>(path: string, token?: string): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    signal: AbortSignal.timeout(20_000),
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "self-host-layer",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 404) throw new Error("Repository, branch or folder not found (private repos need the GitHub App installed on them).");
  if (res.status === 403 || res.status === 429) throw new Error("GitHub rate-limited this request. Connect the GitHub App, or try again in a few minutes.");
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}.`);
  return (await res.json()) as T;
}

export interface RepoInfo {
  defaultBranch: string;
  private: boolean;
}

export async function repoInfo(owner: string, repo: string, token?: string): Promise<RepoInfo> {
  const r = await api<{ default_branch: string; private: boolean }>(`/repos/${owner}/${repo}`, token);
  return { defaultBranch: r.default_branch, private: r.private };
}

export interface Commit {
  sha: string;
  message: string;
  author: string;
}

export async function latestCommit(owner: string, repo: string, branch: string, token?: string): Promise<Commit> {
  const c = await api<{ sha: string; commit: { message: string; author: { name: string } | null } }>(
    `/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
    token,
  );
  return { sha: c.sha, message: c.commit.message.split("\n")[0]!.slice(0, 200), author: c.commit.author?.name ?? "" };
}

/** The files detect() needs from the project's root folder, at a commit. */
export async function projectFiles(owner: string, repo: string, ref: string, rootDir: string, token?: string): Promise<ProjectFiles> {
  const dir = rootDir ? `/${rootDir.split("/").map(encodeURIComponent).join("/")}` : "";
  const listing = await api<{ name: string; type: string }[] | { type: string }>(`/repos/${owner}/${repo}/contents${dir}?ref=${encodeURIComponent(ref)}`, token);
  if (!Array.isArray(listing)) throw new Error(`${rootDir || "The root"} is a file, not a folder.`);
  const names = new Set(listing.filter((e) => e.type === "file").map((e) => e.name));
  const files: ProjectFiles = {};
  for (const name of FILES_TO_CHECK) if (names.has(name)) files[name] = true;
  for (const name of FILES_TO_READ) {
    if (!names.has(name)) continue;
    const f = await api<{ content: string; encoding: string }>(`/repos/${owner}/${repo}/contents${dir}/${name}?ref=${encodeURIComponent(ref)}`, token);
    files[name] = f.encoding === "base64" ? Buffer.from(f.content, "base64").toString("utf8") : f.content;
  }
  return files;
}

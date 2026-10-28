// Importing a repository: read its files, detect how to build and run it,
// and create the project with those settings (each can be changed later).
import { boxConfig, freeHost } from "./box";
import { detect, type Detected } from "./detect";
import { installationToken } from "./github";
import { getApp } from "./github-store";
import { latestCommit, projectFiles, repoInfo } from "./github-repo";
import { pickNodeVersion } from "./node-releases";
import { addDomain } from "./domains";
import { createProject, slugFor, slugTaken, type Project } from "./projects";

const ROOT_DIR = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

export interface ImportInput {
  owner: string;
  repo: string;
  installationId?: number | null;
  rootDir?: string;
  branch?: string;
}

export async function importRepo(input: ImportInput): Promise<{ project: Project; detected: Detected; warnings: string[] }> {
  const rootDir = (input.rootDir ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (rootDir && (!ROOT_DIR.test(rootDir) || rootDir.split("/").some((s) => s === "." || s === ".."))) {
    throw new Error("The root directory must be a folder path like apps/web.");
  }
  let token: string | undefined;
  if (input.installationId) {
    const app = getApp();
    if (!app) throw new Error("Connect GitHub first.");
    token = (await installationToken(app.credentials, input.installationId, { repositories: [input.repo], permissions: { contents: "read", metadata: "read" } })).token;
  }
  const info = await repoInfo(input.owner, input.repo, token);
  const branch = input.branch?.trim() || info.defaultBranch;
  const commit = await latestCommit(input.owner, input.repo, branch, token);
  const detected = detect(await projectFiles(input.owner, input.repo, commit.sha, rootDir, token));
  const box = boxConfig();
  const node = await pickNodeVersion(detected.nodeRange, box.defaultNode);
  const warnings = [...detected.warnings, ...(node.warning ? [node.warning] : [])];

  // A monorepo folder is named after the folder (apps/web → web), a whole repo after the repo.
  const slug = slugFor(rootDir ? rootDir.split("/").at(-1)! : input.repo, slugTaken);
  const project = createProject({
    slug,
    repoOwner: input.owner,
    repoName: input.repo,
    installationId: input.installationId ?? null,
    branch,
    rootDir,
    framework: detected.framework,
    packageManager: detected.packageManager,
    nodeVersion: node.version,
    installCommand: null,
    buildCommand: detected.buildCommand,
    runtime: detected.runtime,
    domains: [freeHost(slug, box)],
    memoryMb: 512,
    autoDeploy: true,
  });
  addDomain(project.id, project.domains[0]!, "free", null, "active");
  return { project, detected, warnings };
}

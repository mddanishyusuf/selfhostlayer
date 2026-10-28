import { FolderGit2 } from "lucide-react";
import Link from "next/link";
import { PublicRepoForm } from "@/components/deploy";
import { RepoSearch } from "@/components/github-connect";
import { Card, FormError } from "@/components/ui";
import { GITHUB_WEB, listInstallationRepos } from "@/lib/github";
import { getApp, listInstallations } from "@/lib/github-store";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "New project" };

export default async function NewProjectPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireUser();
  const app = getApp();
  const { error } = await searchParams;
  if (!app) {
    return (
      <div className="mx-auto grid max-w-[720px] gap-6">
        <header className="grid gap-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">New project</h1>
          <p className="text-muted">Connect GitHub for your private repositories and deploy on push, or deploy any public repository now.</p>
        </header>
        <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
          <div className="grid gap-0.5">
            <p className="font-medium">Your repositories</p>
            <p className="text-[13px] text-muted">Creates a private GitHub App owned by you.</p>
          </div>
          <Link href="/github/connect" className="inline-flex h-9 items-center rounded-md bg-inverse px-4 text-sm font-medium text-inverse-fg transition-opacity duration-150 hover:opacity-90">
            Connect GitHub
          </Link>
        </Card>
        <Card className="p-5">
          <PublicRepoForm />
        </Card>
      </div>
    );
  }
  const installs = listInstallations().filter((i) => !i.suspended);
  const installUrl = `${GITHUB_WEB}/apps/${app.slug}/installations/new`;

  let repos: (Awaited<ReturnType<typeof listInstallationRepos>>[number] & { installationId: number })[] = [];
  let loadError: string | null = null;
  try {
    repos = (await Promise.all(installs.map(async (i) => (await listInstallationRepos(app.credentials, i.id)).map((r) => ({ ...r, installationId: i.id }))))).flat();
  } catch {
    loadError = "Couldn't load repositories from GitHub. Check that the app is still installed, then reload.";
  }
  repos.sort((a, b) => (b.pushed_at ?? "").localeCompare(a.pushed_at ?? ""));

  return (
    <div className="mx-auto grid max-w-[720px] gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">New project</h1>
          <p className="text-muted">Pick a repository to deploy on this server.</p>
        </div>
        <a href={installUrl} className="text-[13px] text-muted underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline">
          Missing a repository? Adjust GitHub access
        </a>
      </header>
      <FormError message={error === "installation" ? "GitHub didn't confirm that installation. Try installing the app again." : loadError} />
      {installs.length === 0 ? (
        <Card className="grid place-items-center gap-4 border-dashed px-6 py-14 text-center">
          <FolderGit2 className="size-6 text-muted" aria-hidden />
          <div className="grid gap-1">
            <p className="font-medium">Install the app on your repositories</p>
            <p className="text-muted">The GitHub App exists, but it can't see any repositories yet.</p>
          </div>
          <a href={installUrl} className="inline-flex h-9 items-center rounded-md bg-inverse px-4 text-sm font-medium text-inverse-fg transition-opacity duration-150 hover:opacity-90">
            Install on GitHub
          </a>
        </Card>
      ) : (
        <RepoSearch repos={repos.map((r) => ({ fullName: r.full_name, private: r.private, pushedAt: r.pushed_at, branch: r.default_branch, installationId: r.installationId }))} />
      )}
      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer px-5 py-3.5 text-[13px] font-medium">Deploy a public repository or a monorepo folder</summary>
        <div className="border-t border-border p-5">
          <PublicRepoForm />
        </div>
      </details>
      <p className="text-[12px] text-muted">
        Connected through <Link href="/github/connect" className="underline-offset-4 hover:underline">{app.name}</Link>.
      </p>
    </div>
  );
}

import { FolderGit2 } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
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
  if (!app) redirect("/github/connect");
  const { error } = await searchParams;
  const installs = listInstallations().filter((i) => !i.suspended);
  const installUrl = `${GITHUB_WEB}/apps/${app.slug}/installations/new`;

  let repos: Awaited<ReturnType<typeof listInstallationRepos>> = [];
  let loadError: string | null = null;
  try {
    repos = (await Promise.all(installs.map((i) => listInstallationRepos(app.credentials, i.id)))).flat();
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
        <RepoSearch repos={repos.map((r) => ({ fullName: r.full_name, private: r.private, pushedAt: r.pushed_at, branch: r.default_branch }))} />
      )}
      <p className="text-[12px] text-muted">
        Connected through <Link href="/github/connect" className="underline-offset-4 hover:underline">{app.name}</Link>.
      </p>
    </div>
  );
}

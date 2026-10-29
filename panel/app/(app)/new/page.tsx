import { GithubIcon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import { PublicRepoForm } from "@/components/deploy";
import { RepoPicker } from "@/components/github-connect";
import { Icon } from "@/components/icon";
import { Empty, PageHeader, PillLink, SettingsRow } from "@/components/page";
import { FormError } from "@/components/ui";
import { GITHUB_WEB } from "@/lib/github";
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
      <>
        <PageHeader title="New project" back="/" meta="Deploy a repository on this server" />
        <SettingsRow title="Your repositories" description="Creates a private GitHub App owned by you: private repositories, deploys on every push, commit statuses.">
          <div>
            <PillLink href="/github/connect" primary>
              <Icon icon={GithubIcon} size={16} /> Connect GitHub
            </PillLink>
          </div>
        </SettingsRow>
        <SettingsRow title="Public repository" description="Any public repository by URL. For a monorepo, give the folder to deploy.">
          <PublicRepoForm />
        </SettingsRow>
      </>
    );
  }
  const installs = listInstallations().filter((i) => !i.suspended);
  const installUrl = `${GITHUB_WEB}/apps/${app.slug}/installations/new`;

  // The list itself loads in the page (RepoPicker), so it shows at once.
  const message = error === "installation" ? "GitHub didn't confirm that installation. Try installing the app again." : null;

  return (
    <>
      <PageHeader
        title="New project"
        back="/"
        meta="Pick a repository to deploy on this server"
        actions={
          <a href={installUrl} className="text-[13px] text-lavender hover:underline">
            Adjust GitHub access
          </a>
        }
      />
      {message && (
        <div className="border-b border-border px-4 py-4 sm:px-7">
          <FormError message={message} />
        </div>
      )}
      {installs.length === 0 ? (
        <section className="border-b border-border">
          <Empty
            action={
              <PillLink href={installUrl} external primary>
                Install on GitHub
              </PillLink>
            }
          >
            <p className="text-[15px] font-semibold text-foreground">Install the app on your repositories</p>
            <p>The GitHub App exists, but it can&apos;t see any repositories yet.</p>
          </Empty>
        </section>
      ) : (
        <RepoPicker />
      )}
      <details className="group border-b border-border">
        <summary className="flex h-[52px] cursor-pointer list-none items-center gap-2 px-4 text-[14px] font-medium text-muted transition-colors hover:bg-hover hover:text-foreground sm:px-7">
          <span className="w-3 text-dim group-open:hidden">+</span>
          <span className="hidden w-3 text-dim group-open:inline">−</span>
          Deploy a public repository or a monorepo folder
        </summary>
        <div className="px-4 pb-6 pt-2 sm:px-7">
          <div className="max-w-[680px]">
            <PublicRepoForm />
          </div>
        </div>
      </details>
      <p className="px-4 py-4 text-[12.5px] text-dim sm:px-7">
        Connected through{" "}
        <Link href="/github/connect" className="text-muted hover:text-foreground hover:underline">
          {app.name}
        </Link>
        .
      </p>
    </>
  );
}

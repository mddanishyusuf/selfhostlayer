import { GithubConnectForm } from "@/components/github-connect";
import { KeyValues, Notice, PageHeader, PillLink, SettingsRow } from "@/components/page";
import { FormError } from "@/components/ui";
import { randomToken } from "@/lib/crypto";
import { buildManifest, GITHUB_WEB } from "@/lib/github";
import { createState, getApp, listInstallations } from "@/lib/github-store";
import { panelOrigin } from "@/lib/origin";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connect GitHub" };

const ERRORS: Record<string, string> = {
  state: "That link from GitHub expired or wasn't started here. Try again.",
  convert: "GitHub didn't accept the app setup. Try again; if it keeps failing, delete the half-created app on GitHub first.",
};

export default async function ConnectGithubPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await requireUser();
  const { error } = await searchParams;
  const app = getApp();

  if (app) {
    const installs = listInstallations();
    return (
      <>
        <PageHeader
          title="GitHub"
          back="/new"
          actions={
            <PillLink href="/new" primary>
              Import a project
            </PillLink>
          }
        />
        <Notice lead="Connected" tone="ok">
          <a className="text-foreground hover:underline" href={app.htmlUrl}>
            {app.name}
          </a>{" "}
          belongs to {app.ownerLogin}, not to us: its private key lives only on this server.
        </Notice>
        <SettingsRow title="Access" description="Which accounts' repositories this server can deploy. Change it on GitHub any time.">
          <KeyValues
            inset
            items={[
              ["Installed on", installs.length === 0 ? <span key="i" className="text-muted">No accounts yet</span> : installs.map((i) => i.accountLogin).join(", ")],
              ["Permissions", "Read code, write commit statuses, push webhooks"],
            ]}
          />
          <div>
            <PillLink href={`${GITHUB_WEB}/apps/${app.slug}/installations/new`}>Install on more repositories</PillLink>
          </div>
        </SettingsRow>
      </>
    );
  }

  const origin = await panelOrigin();
  const host = new URL(origin).hostname.replace(/\.sslip\.io$/, "");
  const name = `Self Host Layer ${host}`.slice(0, 30) + ` ${randomToken(3).slice(0, 3).toLowerCase()}`;
  const manifest = JSON.stringify(buildManifest(origin, name));
  const state = createState(user.id);

  return (
    <>
      <PageHeader title="Connect GitHub" back="/new" meta="A private GitHub App that belongs to you" />
      <Notice lead="Private" tone="lav">
        GitHub hands the app&apos;s key straight to this server. Nothing passes through anyone else.
      </Notice>
      <SettingsRow
        title="Create the app"
        description={
          <>
            1. GitHub opens with the app filled in (read code, commit statuses). Click Create GitHub App.
            <br />
            2. Pick the repositories to deploy, then you come back here automatically.
          </>
        }
      >
        <FormError message={error ? (ERRORS[error] ?? "Something went wrong. Try again.") : null} />
        <GithubConnectForm manifest={manifest} state={state} githubWeb={GITHUB_WEB} />
      </SettingsRow>
    </>
  );
}

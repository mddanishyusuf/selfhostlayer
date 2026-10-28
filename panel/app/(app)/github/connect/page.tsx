import { CircleCheck } from "lucide-react";
import Link from "next/link";
import { GithubConnectForm } from "@/components/github-connect";
import { Card, FormError } from "@/components/ui";
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
      <div className="mx-auto grid max-w-[560px] gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">GitHub</h1>
        <Card className="grid gap-4 p-6">
          <p className="flex items-center gap-2 font-medium">
            <CircleCheck className="size-4 text-ok" aria-hidden /> Connected: <a className="underline-offset-4 hover:underline" href={app.htmlUrl}>{app.name}</a>
          </p>
          <p className="text-muted">
            Installed on {installs.length === 0 ? "no accounts yet" : installs.map((i) => i.accountLogin).join(", ")}. The app belongs to {app.ownerLogin}, not to us: its private key lives only on this server.
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={`${GITHUB_WEB}/apps/${app.slug}/installations/new`} className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium transition-colors duration-150 hover:bg-hover">
              Install on more repositories
            </a>
            <Link href="/new" className="inline-flex h-9 items-center rounded-md bg-inverse px-4 text-sm font-medium text-inverse-fg transition-opacity duration-150 hover:opacity-90">
              Import a project
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  const origin = await panelOrigin();
  const host = new URL(origin).hostname.replace(/\.sslip\.io$/, "");
  const name = `Self Host Layer ${host}`.slice(0, 30) + ` ${randomToken(3).slice(0, 3).toLowerCase()}`;
  const manifest = JSON.stringify(buildManifest(origin, name));
  const state = createState(user.id);

  return (
    <div className="mx-auto grid max-w-[480px] gap-6">
      <header className="grid gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Connect GitHub</h1>
        <p className="text-muted">
          This creates a private GitHub App that belongs to you. GitHub hands its key straight to this server: nothing passes through anyone else.
        </p>
      </header>
      <Card className="grid gap-5 p-6">
        <ol className="grid gap-2 text-[13px] text-muted">
          <li>
            <span className="text-foreground">1.</span> GitHub opens with the app filled in (read code, commit statuses). Click <span className="text-foreground">Create GitHub App</span>.
          </li>
          <li>
            <span className="text-foreground">2.</span> Pick the repositories to deploy, then come back here automatically.
          </li>
        </ol>
        <FormError message={error ? (ERRORS[error] ?? "Something went wrong. Try again.") : null} />
        <GithubConnectForm manifest={manifest} state={state} githubWeb={GITHUB_WEB} />
      </Card>
    </div>
  );
}

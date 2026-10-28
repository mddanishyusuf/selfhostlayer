"use client";

import { FolderGit2, GitBranch } from "lucide-react";
import { useState } from "react";
import { ImportButton } from "./deploy";
import { Button, Field, Input } from "./ui";

/**
 * Posts the app manifest to GitHub from the browser (GitHub's manifest flow
 * requires a form POST). An organization name switches the target.
 */
export function GithubConnectForm({ manifest, state, githubWeb }: { manifest: string; state: string; githubWeb: string }) {
  const [org, setOrg] = useState("");
  const path = org.trim() ? `/organizations/${encodeURIComponent(org.trim())}/settings/apps/new` : "/settings/apps/new";
  return (
    <form method="post" action={`${githubWeb}${path}?state=${encodeURIComponent(state)}`} className="grid gap-4">
      <input type="hidden" name="manifest" value={manifest} />
      <Field label="Organization (optional)" htmlFor="org" hint="Leave empty to create the app on your personal account.">
        <Input id="org" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="acme-inc" autoComplete="off" spellCheck={false} />
      </Field>
      <Button type="submit" className="w-full">
        <GitBranch className="size-4" aria-hidden /> Create GitHub App
      </Button>
    </form>
  );
}

export function RepoSearch({ repos }: { repos: { fullName: string; private: boolean; pushedAt: string | null; branch: string; installationId: number }[] }) {
  const [query, setQuery] = useState("");
  const shown = repos.filter((r) => r.fullName.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="grid gap-3">
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${repos.length} repositories`} aria-label="Search repositories" autoFocus />
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {shown.length === 0 && <p className="px-5 py-8 text-center text-muted">No repositories match “{query}”.</p>}
        {shown.slice(0, 100).map((r) => (
          <div key={r.fullName} className="flex items-center gap-3 px-5 py-3.5 transition-colors duration-150 hover:bg-subtle">
            <FolderGit2 className="size-4 shrink-0 text-muted" aria-hidden />
            <div className="grid min-w-0 flex-1">
              <p className="truncate font-medium">{r.fullName}</p>
              <p className="text-[12px] text-muted">
                {r.private ? "Private" : "Public"} · {r.branch}
                {r.pushedAt ? ` · pushed ${timeAgo(r.pushedAt)}` : ""}
              </p>
            </div>
            <ImportButton repo={r.fullName} installationId={r.installationId} />
          </div>
        ))}
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

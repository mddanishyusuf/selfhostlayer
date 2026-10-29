"use client";

import { GitBranchIcon, GithubIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { ImportButton } from "./deploy";
import { Icon } from "./icon";
import { Dot, ListRow, RowIcon } from "./page";
import { Button, Field, Input, Pill } from "./ui";

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
      <div>
        <Button type="submit">
          <Icon icon={GithubIcon} size={16} /> Create GitHub App
        </Button>
      </div>
    </form>
  );
}

export function RepoSearch({ repos }: { repos: { fullName: string; private: boolean; pushedAt: string | null; branch: string; installationId: number }[] }) {
  const [query, setQuery] = useState("");
  const shown = repos.filter((r) => r.fullName.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <section className="border-b border-border">
      <div className="flex h-[52px] items-center gap-2.5 border-b border-border px-4 sm:px-7">
        <Icon icon={Search01Icon} size={16} className="text-dim" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${repos.length} repositories`}
          aria-label="Search repositories"
          autoFocus
          className="h-full min-w-0 flex-1 bg-transparent text-[14.5px] outline-none placeholder:text-dim"
        />
      </div>
      {shown.length === 0 && <p className="px-4 py-10 text-center text-muted sm:px-7">No repositories match “{query}”.</p>}
      {shown.slice(0, 100).map((r) => (
        <ListRow
          key={r.fullName}
          className="hover:bg-hover"
          lead={
            <RowIcon>
              <Icon icon={GitBranchIcon} size={16} />
            </RowIcon>
          }
          title={
            <>
              <span className="truncate">{r.fullName}</span>
              {r.private && <Pill outline>Private</Pill>}
            </>
          }
          sub={
            <>
              {r.branch}
              {r.pushedAt && (
                <>
                  <Dot /> pushed {timeAgo(r.pushedAt)}
                </>
              )}
            </>
          }
          side={<ImportButton repo={r.fullName} installationId={r.installationId} />}
        />
      ))}
    </section>
  );
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

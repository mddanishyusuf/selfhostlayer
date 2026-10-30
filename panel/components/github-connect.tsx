"use client";

import { GitBranchIcon, GithubIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PickerRepo, RepoPage } from "@/lib/github-repos";
import { ImportButton } from "./deploy";
import { Icon } from "./icon";
import { CARD, Dot, ListRow, RowIcon } from "./page";
import { Button, Field, FormError, Input, NO_AUTOFILL, Pill, Skeleton } from "./ui";

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

const PAGE = 10;

/**
 * The repositories to deploy, most recently pushed first: ten at a time, ten
 * more as you scroll, and a search over all of them by name. The page shows
 * at once; the list comes from /api/github/repos.
 */
export function RepoPicker() {
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<PickerRepo[]>([]);
  const [page, setPage] = useState<{ total: number | null; next: number | null; loading: boolean; error: string | null }>({ total: null, next: null, loading: true, error: null });
  const latest = useRef(0);
  const end = useRef<HTMLDivElement>(null);

  const load = useCallback(async (q: string, offset: number) => {
    const id = ++latest.current;
    setPage((p) => ({ ...p, loading: true, error: null }));
    try {
      const res = await fetch(`/api/github/repos?${new URLSearchParams({ q, offset: String(offset), limit: String(PAGE) })}`);
      const data = (await res.json()) as RepoPage & { error?: string };
      // A newer search (or page) replaced this one while it loaded.
      if (id !== latest.current) return;
      if (!res.ok) throw new Error(data.error ?? "Couldn't load repositories.");
      setRepos((prev) => (offset === 0 ? data.repos : [...prev, ...data.repos.filter((r) => !prev.some((p) => p.fullName === r.fullName))]));
      setPage({ total: data.total, next: data.next, loading: false, error: null });
    } catch (err) {
      if (id === latest.current) setPage((p) => ({ ...p, loading: false, error: (err as Error).message }));
    }
  }, []);

  // A search waits for a pause in typing; an empty box shows the most recent again.
  useEffect(() => {
    const timer = setTimeout(() => void load(query, 0), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  // The next ten load as the end of the list comes near.
  useEffect(() => {
    const el = end.current;
    const next = page.next;
    if (!el || next === null || page.loading || page.error) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void load(query, next);
      },
      { rootMargin: "300px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [page.next, page.loading, page.error, query, load]);

  const term = query.trim();
  return (
    <section className={CARD} data-testid="repo-picker">
      <div className="flex h-[52px] items-center gap-2.5 border-b border-border px-4 sm:px-6">
        <Icon icon={Search01Icon} size={16} className="text-dim" />
        <input
          {...NO_AUTOFILL}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={page.total === null ? "Search repositories" : `Search ${page.total} repositories`}
          aria-label="Search repositories"
          autoFocus
          className="h-full min-w-0 flex-1 bg-transparent text-[14.5px] outline-none placeholder:text-dim"
        />
      </div>
      {repos.map((r) => (
        <RepoRow key={r.fullName} repo={r} />
      ))}
      {page.loading && Array.from({ length: repos.length ? 2 : 6 }, (_, i) => <RepoSkeleton key={i} />)}
      {!page.loading && !page.error && repos.length === 0 && (
        <p className="px-4 py-10 text-center text-muted sm:px-6">{term ? <>No repositories match “{term}”.</> : "The app can't see any repositories yet."}</p>
      )}
      {page.error && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <FormError message={page.error} />
          <Button type="button" variant="secondary" size="sm" onClick={() => void load(query, repos.length ? (page.next ?? 0) : 0)}>
            Try again
          </Button>
        </div>
      )}
      {page.next !== null && <div ref={end} aria-hidden className="h-px" />}
    </section>
  );
}

function RepoRow({ repo: r }: { repo: PickerRepo }) {
  return (
    <ListRow
      className="hover:bg-hover"
      data-repo={r.fullName}
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
  );
}

function RepoSkeleton() {
  return (
    <ListRow
      lead={
        <RowIcon>
          <Icon icon={GitBranchIcon} size={16} />
        </RowIcon>
      }
      title={<Skeleton className="h-4 w-56 max-w-full" />}
      sub={<Skeleton className="h-3 w-32" />}
      side={<Skeleton className="h-8 w-20" />}
    />
  );
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

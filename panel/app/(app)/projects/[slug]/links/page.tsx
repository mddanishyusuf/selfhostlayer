import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyButton } from "@/components/form";
import { FilterBox } from "@/components/header-controls";
import { LinkActions, NewLinkButton, PasswordMark } from "@/components/links";
import { CARD, Empty, Notice, PageHeader, Segmented, TableHead, TableRow } from "@/components/page";
import { StatusChip, timeAgo } from "@/components/status";
import { Pill } from "@/components/ui";
import { isLinks, linksApi, listLinks, shortDomain, type LinkList, type LinksSettings } from "@/lib/links";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Links" };

const PAGE = 50;
const SORTS = [
  ["created", "Newest"],
  ["clicks", "Most clicks"],
  ["slug", "A–Z"],
] as const;
// The short link, its tags, clicks, age and buttons. Phones keep the link, clicks and buttons.
const COLUMNS = "minmax(0,1.7fr) minmax(0,0.8fr) 70px 80px 96px";

export default async function LinksPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ q?: string; tag?: string; sort?: string; page?: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project || !isLinks(project)) notFound();
  const { q, tag, sort: sortParam, page: pageParam } = await searchParams;
  const sort = SORTS.some(([k]) => k === sortParam) ? sortParam! : "created";
  const page = Math.max(1, Number(pageParam) || 1);
  const domain = shortDomain(project);
  let data: LinkList | null = null;
  let settings: LinksSettings | null = null;
  let problem: string | null = null;
  try {
    [data, settings] = await Promise.all([listLinks(project, { q, tag, sort, limit: PAGE, offset: (page - 1) * PAGE }), linksApi<LinksSettings>(project, "settings")]);
  } catch (err) {
    problem = (err as Error).message;
  }
  const href = (next: { tag?: string | null; sort?: string; page?: number }) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    const t = next.tag === undefined ? tag : next.tag;
    if (t) p.set("tag", t);
    const s = next.sort ?? sort;
    if (s !== "created") p.set("sort", s);
    if (next.page && next.page > 1) p.set("page", String(next.page));
    return p.size ? `/projects/${project.slug}/links?${p}` : `/projects/${project.slug}/links`;
  };
  const now = Date.now();

  return (
    <>
      <PageHeader title={project.slug} crumb="Links" meta={`Short links on ${domain}`} actions={settings && <NewLinkButton slug={project.slug} domain={domain} defaultRedirect={settings.defaultRedirect} />} />
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      {data && (data.total > 0 || q || tag) && (
        <div className="flex flex-wrap items-center gap-2.5">
          <Segmented items={SORTS.map(([k, label]) => ({ href: href({ sort: k, page: 1 }), label, active: sort === k }))} />
          {data.tags.length > 0 && (
            <Segmented
              items={[{ href: href({ tag: null, page: 1 }), label: "All tags", active: !tag }, ...data.tags.slice(0, 6).map((t) => ({ href: href({ tag: t.tag, page: 1 }), label: t.tag, count: t.links, active: tag === t.tag }))]}
            />
          )}
          <FilterBox placeholder="Search links, targets, titles" className="order-last min-w-full flex-1 sm:order-none sm:ml-auto sm:min-w-[220px] sm:max-w-[340px]" />
        </div>
      )}
      {data && (
        <section className={CARD} data-testid="links-list">
          {data.links.length === 0 ? (
            <Empty action={!q && !tag && settings ? <NewLinkButton slug={project.slug} domain={domain} defaultRedirect={settings.defaultRedirect} /> : undefined}>
              {q || tag ? (
                <p>No links match.</p>
              ) : (
                <>
                  <p className="text-[17px] font-bold text-foreground">No links yet</p>
                  <p>
                    Make one: <code className="font-mono text-[13px]">{domain}/launch</code> → any page. Clicks are counted without cookies.
                  </p>
                </>
              )}
            </Empty>
          ) : (
            <>
              <TableHead columns={COLUMNS}>
                <span>Link</span>
                <span>Tags</span>
                <span className="text-right">Clicks</span>
                <span>Made</span>
                <span />
              </TableHead>
              {data.links.map((l) => {
                const url = `https://${domain}/${l.slug}`;
                const expired = l.expiresAt !== null && l.expiresAt <= now;
                return (
                  <TableRow key={l.id} columns={COLUMNS} data-testid={`link-${l.slug}`}>
                    <div className="grid min-w-0 flex-1 gap-px">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <a href={url} target="_blank" rel="noreferrer" className="truncate font-bold hover:underline">
                          {/* Phones have room for the slug; the domain is in the header. */}
                          <span className="max-md:hidden">{domain}</span>/{l.slug}
                        </a>
                        <CopyButton text={url} />
                        {l.hasPassword && <PasswordMark />}
                        {l.disabled ? <StatusChip status="idle" label="Off" /> : expired ? <StatusChip status="warn" label="Expired" /> : null}
                      </span>
                      <span className="truncate text-[12px] text-muted" title={l.target}>
                        {l.title && <span className="text-foreground">{l.title} · </span>}
                        {l.target}
                      </span>
                    </div>
                    <span className="flex min-w-0 flex-wrap gap-1 max-md:hidden">
                      {l.tags.map((t) => (
                        <Link key={t} href={href({ tag: t, page: 1 })}>
                          <Pill>{t}</Pill>
                        </Link>
                      ))}
                    </span>
                    <Link href={`/projects/${project.slug}/stats?link=${l.id}`} className="text-right tabular-nums hover:underline max-md:ml-auto" title="Its stats">
                      {l.clicks.toLocaleString("en")}
                    </Link>
                    <span className="text-[12px] text-muted max-md:hidden">{timeAgo(Math.floor(l.createdAt / 1000))}</span>
                    <LinkActions slug={project.slug} domain={domain} link={l} defaultRedirect={settings!.defaultRedirect} />
                  </TableRow>
                );
              })}
            </>
          )}
        </section>
      )}
      {data && data.total > PAGE && (
        <div className="flex items-center justify-between text-[12px] text-muted">
          <span>
            {(page - 1) * PAGE + 1}–{Math.min(page * PAGE, data.total)} of {data.total}
          </span>
          <span className="flex gap-3">
            {page > 1 && (
              <Link href={href({ page: page - 1 })} className="text-accent hover:underline">
                Previous
              </Link>
            )}
            {page * PAGE < data.total && (
              <Link href={href({ page: page + 1 })} className="text-accent hover:underline">
                Next
              </Link>
            )}
          </span>
        </div>
      )}
    </>
  );
}

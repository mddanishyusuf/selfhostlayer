import { notFound } from "next/navigation";
import { ImportLinksForm, NewTokenForm, RevokeTokenButton } from "@/components/links";
import { Notice, PageHeader, PillLink, Section, TableHead, TableRow } from "@/components/page";
import { timeAgo } from "@/components/status";
import { isLinks, linksApi, shortDomain, type ApiToken } from "@/lib/links";
import { getProjectBySlug } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Links API" };

const COLUMNS = "minmax(0,1fr) 130px 110px 110px 90px";

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto bg-well px-3 py-2.5 font-mono text-[12.5px] leading-relaxed">{children}</pre>;
}

export default async function LinksApiPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project || !isLinks(project)) notFound();
  const domain = shortDomain(project);
  const api = `https://${domain}/api/v1/links`;
  let tokens: ApiToken[] | null = null;
  let problem: string | null = null;
  try {
    tokens = (await linksApi<{ tokens: ApiToken[] }>(project, "tokens")).tokens;
  } catch (err) {
    problem = (err as Error).message;
  }
  const ago = (ms: number | null) => (ms ? timeAgo(Math.floor(ms / 1000)) : "Never");

  return (
    <>
      <PageHeader title={project.slug} crumb="API" meta="Make, change and list links from scripts and other apps" />
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      {tokens && (
        <Section title="Tokens" description="A token can make, change and delete any link. It's shown once; only its hash is kept." aside={<NewTokenForm slug={project.slug} />}>
          <div className="border-t border-border" data-testid="tokens">
            {tokens.length === 0 ? (
              <p className="px-3.5 py-4 text-[13px] text-muted">No tokens yet.</p>
            ) : (
              <>
                <TableHead columns={COLUMNS}>
                  <span>Name</span>
                  <span>Token</span>
                  <span>Made</span>
                  <span>Last used</span>
                  <span />
                </TableHead>
                {tokens.map((t) => (
                  <TableRow key={t.id} columns={COLUMNS}>
                    <span className="truncate font-medium">{t.name}</span>
                    <code className="font-mono text-[12.5px] text-muted">{t.prefix}…</code>
                    <span className="text-[12px] text-muted max-md:hidden">{ago(t.createdAt)}</span>
                    <span className="text-[12px] text-muted max-md:hidden">{ago(t.lastUsedAt)}</span>
                    <RevokeTokenButton slug={project.slug} id={t.id} name={t.name} />
                  </TableRow>
                ))}
              </>
            )}
          </div>
        </Section>
      )}
      <Section title="Calling it" description={`Send the token as Authorization: Bearer <token>. Each token gets 120 requests a minute.`}>
        <div className="grid gap-3 border-t border-border px-3.5 py-3.5 text-[13px]">
          <p>Make a link (leave out the slug for a random one):</p>
          <Code>{`curl -X POST ${api} \\
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{"target": "https://example.com/launch", "slug": "launch", "tags": ["twitter"]}'`}</Code>
          <p>List them (q searches, tag filters, sort is created, clicks or slug), then read, change or delete one by its slug:</p>
          <Code>{`curl "${api}?q=launch&sort=clicks" -H "Authorization: Bearer $TOKEN"
curl ${api}/launch -H "Authorization: Bearer $TOKEN"
curl -X PATCH ${api}/launch -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" -d '{"disabled": true}'
curl -X DELETE ${api}/launch -H "Authorization: Bearer $TOKEN"`}</Code>
          <p className="text-muted">
            A link has <code className="font-mono">target</code>, <code className="font-mono">slug</code>, <code className="font-mono">title</code>, <code className="font-mono">tags</code>,{" "}
            <code className="font-mono">redirect</code> (301, 302, 307 or 308), <code className="font-mono">passQuery</code>, <code className="font-mono">password</code> (write only),{" "}
            <code className="font-mono">expiresAt</code> (a date) and <code className="font-mono">disabled</code>. Answers include <code className="font-mono">shortUrl</code> and <code className="font-mono">clicks</code>. Errors say which field is wrong.
          </p>
        </div>
      </Section>
      <Section title="CSV" description="Every link as a file, or links from a file: Links' own export, or another shortener's (url, slug, title and tags columns are recognised).">
        <div className="grid gap-4 border-t border-border px-3.5 py-3.5">
          <div>
            <PillLink href={`/api/projects/${project.slug}/links-csv`} size="sm">
              Export CSV
            </PillLink>
          </div>
          <ImportLinksForm slug={project.slug} />
        </div>
      </Section>
    </>
  );
}

import Link from "next/link";
import { CodeBlock, RemoveSite, RemoveSourceButton, RevenueTabs, Snippet, SourceForm, SubdomainsToggle, SyncNowButton } from "@/components/analytics-forms";
import { when } from "@/components/analytics-ui";
import { KeyValues, Notice, PageHeader, SettingsRow } from "@/components/page";
import { PROVIDERS, siteFor, snippet, sourcesOf, takesProvider, webhookUrl, type Source } from "@/lib/analytics";
import { installedVersion } from "@/lib/deploy";
import { GUIDES } from "@/lib/revenue-guides";

export const dynamic = "force-dynamic";
export const metadata = { title: "Site settings" };

function SourceStatus({ s, webhook }: { s: Source; webhook: boolean }) {
  const status = s.syncing ? "Syncing…" : s.error ? <span className="text-rose">{s.error}</span> : webhook ? (s.syncedAt ? `Last webhook ${when(s.syncedAt)} UTC` : "Waiting for its first webhook") : s.syncedAt ? `Synced ${when(s.syncedAt)} UTC` : "Waiting for its first sync";
  return (
    <KeyValues
      inset
      items={[
        ["Status", status],
        ["Mode", s.mode === "live" ? "Live" : "Test"],
        [webhook ? "Secret" : "Key", <code key="k" className="font-mono text-[12.5px]">…{s.keyHint}</code>],
        ["Payments", s.payments.toLocaleString("en")],
      ]}
    />
  );
}

export default async function SiteSettingsPage({ params }: { params: Promise<{ site: string }> }) {
  const ctx = await siteFor((await params).site);
  if (!ctx) return null;
  const { project, site } = ctx;
  let sources: Source[] = [];
  let problem: string | null = null;
  // Payment providers came in Analytics 0.2.0: before it, the layout offers the update.
  if (!ctx.outdated) {
    try {
      sources = await sourcesOf(project, site.id);
    } catch (err) {
      problem = (err as Error).message;
    }
  }
  return (
    <>
      <PageHeader title={site.domain} crumb="Settings" meta="How the site is counted, and where its revenue comes from" />
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      <SettingsRow title="The line to paste" description={`Into every page of ${site.domain}, before </head>. It sets no cookies and is under 3 KB.`}>
        <Snippet code={snippet(project, site.domain)} />
        <p className="text-[12px] text-muted">
          It counts pageviews (single-page apps too), time on page and clicks on links to other sites. Custom events: <code className="font-mono">window.shl.track(&quot;Signup&quot;, {"{"} plan: &quot;pro&quot; {"}"})</code>.
        </p>
      </SettingsRow>
      <SettingsRow title="Subdomains" description="www. always counts as the site.">
        <SubdomainsToggle id={site.id} on={site.subdomains} />
      </SettingsRow>
      {!ctx.outdated && (
        <>
          <SettingsRow id="revenue" title="Revenue attribution" description="Which visits, sources and campaigns bring in the money. Connect a provider, and pass the visit into its checkout as shl_visit.">
            <RevenueTabs
              tabs={PROVIDERS.map((provider) => {
                const s = sources.find((x) => x.provider === provider.id);
                const guide = GUIDES[provider.id];
                return {
                  id: provider.id,
                  name: provider.name,
                  connected: !!s,
                  failing: !!s?.error,
                  panel: (
                    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
                      <p className="text-[13px] text-muted">{guide.counts}</p>
                      {s && <SourceStatus s={s} webhook={!!guide.webhook} />}
                      {takesProvider(project, provider) ? (
                        <SourceForm site={site.id} provider={provider.id} connected={!!s} webhookUrl={guide.webhook ? webhookUrl(project, site.id, provider.id) : undefined} />
                      ) : (
                        <Notice lead="Update" tone="gold">
                          Analytics to {provider.since} or newer for {provider.name}: this one is {installedVersion(project.id)?.version}. Its Settings page has the update.
                        </Notice>
                      )}
                      {s && <RemoveSourceButton site={site.id} provider={provider.id} name={provider.name} />}
                      <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5 border-t border-border pt-3">
                        <b className="text-[13px]">Pass the visit</b>
                        <CodeBlock code={guide.code} testId={`code-${provider.id}`} />
                        {guide.links && <p className="text-[12px] text-muted">{guide.links}</p>}
                      </div>
                    </div>
                  ),
                };
              })}
            />
            <p className="text-[12px] text-muted">A renewal, or a customer&apos;s next purchase, goes to their first visit. Kept for each payment: the amount without tax, its currency and time, and the customer&apos;s id, never their email or name.</p>
            {sources.some((x) => !GUIDES[x.provider].webhook) && <SyncNowButton site={site.id} />}
          </SettingsRow>
        </>
      )}
      <SettingsRow title="Remove the site" description="Deletes everything counted for it, payments included.">
        <div>
          <RemoveSite id={site.id} domain={site.domain} />
        </div>
      </SettingsRow>
      <p className="text-[12px] text-dim">
        How long visits are kept, for every site:{" "}
        <Link href={`/projects/${project.slug}/settings`} className="text-accent hover:underline">
          Analytics&apos; settings
        </Link>
        .
      </p>
    </>
  );
}

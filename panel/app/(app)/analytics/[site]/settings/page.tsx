import Link from "next/link";
import { RemoveSite, RemoveSourceButton, Snippet, SourceForm, SubdomainsToggle, SyncNowButton } from "@/components/analytics-forms";
import { when } from "@/components/analytics-ui";
import { KeyValues, Notice, PageHeader, SettingsRow } from "@/components/page";
import { Pill } from "@/components/ui";
import { PROVIDERS, siteFor, snippet, sourcesOf, type Source } from "@/lib/analytics";

export const dynamic = "force-dynamic";
export const metadata = { title: "Site settings" };

const CHECKOUT = `// In the page: the visit, from the script
const visit = window.shl ? await window.shl.ready : null;

// On your server, where the checkout is made:
metadata: { shl_visit: visit }`;

function SourceStatus({ s }: { s: Source }) {
  return (
    <KeyValues
      inset
      items={[
        ["Status", s.syncing ? "Syncing…" : s.error ? <span className="text-rose">{s.error}</span> : s.syncedAt ? `Synced ${when(s.syncedAt)} UTC` : "Waiting for its first sync"],
        ["Mode", s.mode === "live" ? "Live" : "Test"],
        ["Key", <code key="k" className="font-mono text-[12.5px]">…{s.keyHint}</code>],
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
  try {
    sources = await sourcesOf(project, site.id);
  } catch (err) {
    problem = (err as Error).message;
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
      <SettingsRow id="revenue" title="Credit payments to visits" description="So Revenue shows what each source, campaign and page brings in.">
        <p className="text-[13px]">
          Pass the visit into your checkout&apos;s metadata as <code className="font-mono">shl_visit</code>. Stripe&apos;s Payment Links and Dodo Payments&apos; links on your pages get it when clicked, with nothing to add.
        </p>
        <pre className="overflow-x-auto bg-well px-3 py-2.5 font-mono text-[12.5px] leading-relaxed">{CHECKOUT}</pre>
        <p className="text-[12px] text-muted">A renewal, or a customer&apos;s next purchase, goes to their first visit. Kept for each payment: the amount without tax, its currency and time, and the customer&apos;s id, never their email or name.</p>
        {sources.length > 0 && <SyncNowButton site={site.id} />}
      </SettingsRow>
      {PROVIDERS.map(({ id, name }) => {
        const s = sources.find((x) => x.provider === id);
        return (
          <SettingsRow
            key={id}
            id={`provider-${id}`}
            title={
              <span className="flex items-center gap-2">
                {name} {s && <Pill outline>{s.error ? "Failing" : "Connected"}</Pill>}
              </span>
            }
            description={
              id === "stripe"
                ? "Completed checkouts, and paid invoices for renewals."
                : id === "polar"
                  ? "Paid orders, from production or the sandbox."
                  : "Succeeded payments, in your account's currency."
            }
          >
            {s && <SourceStatus s={s} />}
            <SourceForm site={site.id} provider={id} connected={!!s} />
            {s && <RemoveSourceButton site={site.id} provider={id} name={name} />}
          </SettingsRow>
        );
      })}
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

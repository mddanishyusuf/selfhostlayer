import { redirect } from "next/navigation";
import { AnalyticsBar, AnalyticsNav } from "@/components/analytics-nav";
import { UpdateButton } from "@/components/integrations";
import { CARD, Notice, PageHeader, PillLink } from "@/components/page";
import { cx } from "@/components/ui";
import { analyticsInstall, outdatedAnalytics, REPORTS_SINCE, sitesOnce, suggestedDomains, type Site } from "@/lib/analytics";
import { catalogApps, updateFor } from "@/lib/catalog";
import { installedVersion } from "@/lib/deploy";
import { requireUser } from "@/lib/session";

/**
 * A site's Analytics: its own sidebar beside the panel's (which shrinks to its
 * icons here), full height from the page's edge, and the page beside it.
 */
export default async function SiteLayout({ children, params }: { children: React.ReactNode; params: Promise<{ site: string }> }) {
  await requireUser();
  const project = analyticsInstall();
  if (!project) redirect("/analytics");
  const domain = decodeURIComponent((await params).site);
  let sites: Site[];
  try {
    sites = await sitesOnce(project);
  } catch (err) {
    return (
      <>
        <PageHeader title="Analytics" crumb={domain} />
        <Notice lead="Not reachable" tone="err">
          {(err as Error).message}
        </Notice>
      </>
    );
  }
  const site = sites.find((s) => s.domain === domain);
  if (!site) redirect("/analytics");
  const nav = sites.map((s) => ({ domain: s.domain, visitors: s.visitors, live: s.live }));
  const suggestions = suggestedDomains(sites);
  // The panel can be updated before Analytics: offer its update until the pages' reports are there.
  const outdated = outdatedAnalytics(project);
  const update = outdated ? updateFor(outdated, (await catalogApps().catch(() => [])).find((a) => a.id === "analytics")) : null;
  return (
    // Out to the main area's edges (its padding in app/(app)/layout.tsx), then the same padding inside.
    <div className="-mx-4 -mb-16 -mt-4 flex sm:-mx-6 md:-mx-7 md:-mt-[22px]">
      <AnalyticsNav sites={nav} current={site.domain} live={site.live} suggestions={suggestions} manage={`/projects/${project.slug}`} version={installedVersion(project.id)?.version ?? null} />
      <div className="page-stack grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-3.5 px-4 pb-16 pt-4 sm:px-6 md:px-7 md:pt-[22px]">
        <AnalyticsBar sites={nav} current={site.domain} suggestions={suggestions} />
        {outdated && (
          <section className={cx(CARD, "flex flex-wrap items-center justify-between gap-3 px-3.5 py-3")} data-testid="analytics-outdated">
            <p className="min-w-0 max-w-[640px]">
              <b className="mr-1.5 font-bold text-gold">Update Analytics.</b>
              Realtime, Pages, Users, Goals, Revenue and Outbound need Analytics {REPORTS_SINCE} or newer; this server runs {outdated}. Its data stays, and it&apos;s backed up first when backups are on.
            </p>
            {update ? <UpdateButton slug={project.slug} version={update.version} /> : <PillLink href="/integrations">Open Integrations</PillLink>}
          </section>
        )}
        {children}
      </div>
    </div>
  );
}

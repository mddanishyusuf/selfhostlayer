import { redirect } from "next/navigation";
import { AnalyticsBar, AnalyticsNav } from "@/components/analytics-nav";
import { Notice, PageHeader } from "@/components/page";
import { analyticsInstall, sitesOnce, suggestedDomains, type Site } from "@/lib/analytics";
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
  return (
    // Out to the main area's edges (its padding in app/(app)/layout.tsx), then the same padding inside.
    <div className="-mx-4 -mb-16 -mt-4 flex sm:-mx-6 md:-mx-7 md:-mt-[22px]">
      <AnalyticsNav sites={nav} current={site.domain} live={site.live} suggestions={suggestions} manage={`/projects/${project.slug}`} version={installedVersion(project.id)?.version ?? null} />
      <div className="page-stack grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-3.5 px-4 pb-16 pt-4 sm:px-6 md:px-7 md:pt-[22px]">
        <AnalyticsBar sites={nav} current={site.domain} suggestions={suggestions} />
        {children}
      </div>
    </div>
  );
}

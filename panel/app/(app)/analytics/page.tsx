import { ChartColumnIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { FirstSite } from "@/components/analytics-forms";
import { Icon } from "@/components/icon";
import { InstallButton } from "@/components/integrations";
import { CARD, Notice, PageHeader, TileIcon } from "@/components/page";
import { Pill, cx } from "@/components/ui";
import { analyticsInstall, listSites, suggestedDomains, type Site } from "@/lib/analytics";
import { catalogApps } from "@/lib/catalog";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics" };

function NotInstalled({ install }: { install: React.ReactNode }) {
  return (
    <section className={cx(CARD, "grid justify-items-center gap-3 px-6 py-12 text-center")}>
      <TileIcon tone="blue">
        <Icon icon={ChartColumnIcon} size={20} />
      </TileIcon>
      <p className="text-[17px] font-bold">Cookie-free analytics for your sites</p>
      <p className="max-w-[540px] text-muted">
        Visitors, pages, sources, goals and the revenue each source brings in (Stripe, Polar, Dodo Payments) for each site you add, with no cookies and nothing leaving this server. Analytics installs like your apps, then one line in a site&apos;s pages
        starts the counting.
      </p>
      {install}
    </section>
  );
}

/** Install, or the first site; with sites, the first one's Overview (?site=<id> was the old way to pick one). */
export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ site?: string }> }) {
  await requireUser();
  const project = analyticsInstall();
  if (!project) {
    const app = (await catalogApps().catch(() => [])).find((a) => a.id === "analytics");
    const version = app?.versions.find((v) => v.supported);
    return (
      <>
        <PageHeader title="Analytics" meta="Cookie-free, on your own server" />
        <NotInstalled install={version ? <InstallButton app="analytics" /> : app ? <Pill outline>Needs {app.versions[0]!.minPanel} or newer</Pill> : <Pill outline>Coming soon to the catalog</Pill>} />
      </>
    );
  }
  let sites: Site[] = [];
  let problem: string | null = null;
  try {
    sites = await listSites(project);
  } catch (err) {
    problem = (err as Error).message;
  }
  if (sites.length) {
    const asked = Number((await searchParams).site);
    redirect(`/analytics/${(sites.find((s) => s.id === asked) ?? sites[0]!).domain}`);
  }
  return (
    <>
      <PageHeader title="Analytics" meta="Cookie-free, on your own server" />
      {problem ? (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      ) : (
        <section className={CARD}>
          <div className="px-3.5 pt-3.5">
            <h2 className="text-[14px] font-bold">Add your first site</h2>
            <p className="text-[12px] text-muted">A domain whose pages will send visits here.</p>
          </div>
          <FirstSite suggestions={suggestedDomains(sites)} />
        </section>
      )}
    </>
  );
}

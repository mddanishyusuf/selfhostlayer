import { ChartColumn } from "lucide-react";
import { ComingSoon, PageBody, PageHeader } from "@/components/page";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Analytics" };

export default async function AnalyticsPage() {
  await requireUser();
  return (
    <>
      <PageHeader title="Analytics" />
      <PageBody>
        <ComingSoon icon={<ChartColumn className="size-5" aria-hidden />} title="Privacy-friendly analytics for every project">
          Visitors, pages, referrers and countries for each site you deploy, with no cookies and no third party: the data stays on this server. It comes with Integrations, powered by Piqo.
        </ComingSoon>
      </PageBody>
    </>
  );
}

import { Analytics01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/icon";
import { ComingSoon, PageHeader } from "@/components/page";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Analytics" };

export default async function AnalyticsPage() {
  await requireUser();
  return (
    <>
      <PageHeader title="Analytics" meta="Powered by Piqo · cookie-free" />
      <ComingSoon icon={<Icon icon={Analytics01Icon} size={20} />} title="Privacy-friendly analytics for every project">
        Visitors, pages, sources, countries and devices for each site you deploy, a live view of who&apos;s online, events and funnels. No cookies and no third party: the data stays on this server. It comes with Integrations, powered by Piqo.
      </ComingSoon>
    </>
  );
}

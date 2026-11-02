import { CARD, PageHeader } from "@/components/page";
import { NewSiteForm } from "@/components/site-forms";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "New site" };

export default async function NewSitePage({ searchParams }: { searchParams: Promise<{ engine?: string }> }) {
  await requireUser();
  const { engine } = await searchParams;
  return (
    <>
      <PageHeader title="New site" meta="Installed in about a minute, on this server, with HTTPS" back="/sites" />
      <section className={CARD}>
        <NewSiteForm engine={engine === "ghost" ? "ghost" : "wordpress"} />
      </section>
    </>
  );
}

import { MailIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { FirstBrand } from "@/components/email-forms";
import { Icon } from "@/components/icon";
import { InstallButton } from "@/components/integrations";
import { CARD, Notice, PageHeader, TileIcon } from "@/components/page";
import { Pill, cx } from "@/components/ui";
import { catalogApps } from "@/lib/catalog";
import { emailInstall, listBrands, type Brand } from "@/lib/email";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Email" };

/** Install, or the first brand; with brands, the first one's Overview. */
export default async function EmailPage() {
  await requireUser();
  const project = emailInstall();
  if (!project) {
    const app = (await catalogApps().catch(() => [])).find((a) => a.id === "email");
    const version = app?.versions.find((v) => v.supported);
    return (
      <>
        <PageHeader title="Email" meta="Newsletters, transactional email and automations" />
        <section className={cx(CARD, "grid justify-items-center gap-3 px-6 py-12 text-center")}>
          <TileIcon tone="coral">
            <Icon icon={MailIcon} size={20} />
          </TileIcon>
          <p className="text-[17px] font-bold">Email for your products, on your own server</p>
          <p className="max-w-[560px] text-muted">
            Newsletters to your lists, transactional email from your apps through an API that works with Resend&apos;s SDKs, and automations like welcome series. It sends through any SMTP provider or Amazon SES, signs with DKIM, and handles
            unsubscribes and bounces. One install, any number of brands.
          </p>
          {version ? <InstallButton app="email" /> : app ? <Pill outline>Needs {app.versions[0]!.minPanel} or newer</Pill> : <Pill outline>Coming soon to the catalog</Pill>}
        </section>
      </>
    );
  }
  let brands: Brand[] = [];
  let problem: string | null = null;
  try {
    brands = await listBrands(project);
  } catch (err) {
    problem = (err as Error).message;
  }
  if (brands.length) redirect(`/email/${brands[0]!.id}`);
  return (
    <>
      <PageHeader title="Email" meta="Newsletters, transactional email and automations" />
      {problem ? (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      ) : (
        <section className={CARD}>
          <div className="px-3.5 pt-3.5">
            <h2 className="text-[14px] font-bold">Add your first brand</h2>
            <p className="text-[12px] text-muted">A product you send email for: its own domains, contacts, campaigns and keys.</p>
          </div>
          <FirstBrand />
        </section>
      )}
    </>
  );
}

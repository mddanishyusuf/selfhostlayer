import { MailIcon } from "lucide-react";
import { FirstBrand, NewBrandButton } from "@/components/email-forms";
import { BrandLogo } from "@/components/email-logo";
import { Icon } from "@/components/icon";
import { InstallButton } from "@/components/integrations";
import { CARD, Notice, PageHeader, TableHead, TableRow, TileIcon } from "@/components/page";
import { Pill, cx } from "@/components/ui";
import { catalogApps } from "@/lib/catalog";
import { emailInstall, listBrands, type Brand } from "@/lib/email";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Email" };

const COLUMNS = "minmax(220px,1.6fr) minmax(160px,1fr) 110px 110px 120px";
const PROVIDER = { smtp: "SMTP", ses: "Amazon SES", none: "Not set up" } as const;

/** Install, or the first brand; with brands, the list of them to pick from. */
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
  if (brands.length)
    return (
      <>
        <PageHeader title="Email" meta="Pick a brand: each has its own domains, contacts, campaigns and keys" actions={<NewBrandButton />} />
        <section className={CARD} data-testid="brand-list">
          <TableHead columns={COLUMNS}>
            <span>Brand</span>
            <span>Sends from</span>
            <span className="text-right">Contacts</span>
            <span className="text-right">Sent, 30 days</span>
            <span className="text-right">Provider</span>
          </TableHead>
          {brands.map((b) => (
            <TableRow key={b.id} columns={COLUMNS} href={`/email/${b.id}`} data-testid="brand-row">
              <span className="flex min-w-0 items-center gap-3">
                <BrandLogo name={b.name} domain={b.domain} size={30} />
                <span className="grid min-w-0 gap-px">
                  <b className="truncate font-bold">{b.name}</b>
                  {b.website && <span className="truncate text-[12px] text-muted">{b.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>}
                </span>
              </span>
              <span className="truncate text-muted max-md:hidden">
                {b.fromEmail ? b.fromEmail.split("@")[1] : b.domain ?? "No domain yet"}
                {b.verified ? <span className="text-ok"> · verified</span> : b.domain ? <span className="text-warn"> · not verified</span> : null}
              </span>
              <span className="text-right tabular-nums max-md:hidden">{(b.contacts ?? 0).toLocaleString("en")}</span>
              <span className="text-right tabular-nums text-muted max-md:hidden">{(b.sent30d ?? 0).toLocaleString("en")}</span>
              <span className={cx("text-right max-md:ml-auto", b.provider === "none" ? "text-warn" : "text-muted")}>{PROVIDER[b.provider]}</span>
            </TableRow>
          ))}
        </section>
      </>
    );
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

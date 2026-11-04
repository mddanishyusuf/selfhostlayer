import { redirect } from "next/navigation";
import { EmailBar, EmailNav } from "@/components/email-nav";
import { Notice, PageHeader } from "@/components/page";
import { installedVersion } from "@/lib/deploy";
import { brandsOnce, emailInstall, type Brand } from "@/lib/email";
import { requireUser } from "@/lib/session";

/** A brand's Email: its own sidebar beside the panel's (which shrinks to its icons here), and the page beside it. */
export default async function BrandLayout({ children, params }: { children: React.ReactNode; params: Promise<{ brand: string }> }) {
  await requireUser();
  const project = emailInstall();
  if (!project) redirect("/email");
  const id = (await params).brand;
  let brands: Brand[];
  try {
    brands = await brandsOnce(project);
  } catch (err) {
    return (
      <>
        <PageHeader title="Email" />
        <Notice lead="Not reachable" tone="err">
          {(err as Error).message}
        </Notice>
      </>
    );
  }
  const brand = brands.find((b) => String(b.id) === id);
  if (!brand) redirect("/email");
  const nav = brands.map((b) => ({ id: b.id, name: b.name, contacts: b.contacts ?? 0, domain: b.domain ?? null }));
  const current = nav.find((b) => b.id === brand.id)!;
  return (
    // Out to the main area's edges (its padding in app/(app)/layout.tsx), then the same padding inside.
    <div className="-mx-4 -mb-16 -mt-4 flex sm:-mx-6 md:-mx-7 md:-mt-[22px]">
      <EmailNav brands={nav} current={current} manage={`/projects/${project.slug}`} version={installedVersion(project.id)?.version ?? null} />
      <div className="page-stack grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-3.5 px-4 pb-16 pt-4 sm:px-6 md:px-7 md:pt-[22px]">
        <EmailBar brands={nav} current={current} />
        {children}
      </div>
    </div>
  );
}

import { redirect } from "next/navigation";
import { FormsBar, FormsNav } from "@/components/forms-nav";
import { Notice, PageHeader } from "@/components/page";
import { installedVersion } from "@/lib/deploy";
import { formsInstall, formsOnce, type Form } from "@/lib/forms";
import { requireUser } from "@/lib/session";

/** A form's pages: Forms' own sidebar beside the panel's (which shrinks to its icons here), and the page beside it. */
export default async function FormLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  await requireUser();
  const project = formsInstall();
  if (!project) redirect("/forms");
  const id = (await params).id;
  let forms: Form[];
  try {
    forms = await formsOnce(project);
  } catch (err) {
    return (
      <>
        <PageHeader title="Forms" />
        <Notice lead="Not reachable" tone="err">
          {(err as Error).message}
        </Notice>
      </>
    );
  }
  const form = forms.find((f) => String(f.id) === id);
  if (!form) redirect("/forms");
  const nav = forms.map((f) => ({ id: f.id, title: f.title, responses: f.responses, open: !f.closed }));
  const current = nav.find((f) => f.id === form.id)!;
  return (
    // Out to the main area's edges (its padding in app/(app)/layout.tsx), then the same padding inside.
    <div className="-mx-4 -mb-16 -mt-4 flex sm:-mx-6 md:-mx-7 md:-mt-[22px]">
      <FormsNav forms={nav} current={current} manage={`/projects/${project.slug}`} version={installedVersion(project.id)?.version ?? null} />
      <div className="page-stack grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-3.5 px-4 pb-16 pt-4 sm:px-6 md:px-7 md:pt-[22px]">
        <FormsBar forms={nav} current={current} />
        {children}
      </div>
    </div>
  );
}

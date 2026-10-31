import { notFound } from "next/navigation";
import { TemplateEditor } from "@/components/email-forms";
import { Notice, PageHeader } from "@/components/page";
import { brandFor, EmailError, templateOf, type Template } from "@/lib/email";

export const dynamic = "force-dynamic";
export const metadata = { title: "Template" };

export default async function TemplatePage({ params }: { params: Promise<{ brand: string; id: string }> }) {
  const { brand: b, id } = await params;
  const ctx = await brandFor(b);
  if (!ctx) return null;
  let t: Template;
  try {
    t = await templateOf(ctx.project, ctx.brand.id, Number(id));
  } catch (err) {
    if (err instanceof EmailError && err.status === 404) notFound();
    return (
      <Notice lead="Not reachable" tone="err">
        {(err as Error).message}
      </Notice>
    );
  }
  return (
    <>
      <PageHeader title={ctx.brand.name} crumb={t.name} back={`/email/${ctx.brand.id}/templates`} meta={<>Send it with <code className="font-mono">{`template: { id: ${t.id}, variables: {…} }`}</code></>} />
      <TemplateEditor brand={ctx.brand} template={t} />
    </>
  );
}

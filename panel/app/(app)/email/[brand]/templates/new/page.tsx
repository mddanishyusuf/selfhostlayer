import { TemplateEditor } from "@/components/email-forms";
import { PageHeader } from "@/components/page";
import { brandFor } from "@/lib/email";

export const dynamic = "force-dynamic";
export const metadata = { title: "New template" };

export default async function NewTemplatePage({ params }: { params: Promise<{ brand: string }> }) {
  const ctx = await brandFor((await params).brand);
  if (!ctx) return null;
  return (
    <>
      <PageHeader title={ctx.brand.name} crumb="New template" back={`/email/${ctx.brand.id}/templates`} />
      <TemplateEditor brand={ctx.brand} />
    </>
  );
}

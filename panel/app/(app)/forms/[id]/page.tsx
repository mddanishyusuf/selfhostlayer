import { FormBuilder } from "@/components/forms-builder";
import { FormStatus } from "@/components/forms-ui";
import { Notice, PageHeader } from "@/components/page";
import { formFor, formOf, formsPublicUrl } from "@/lib/forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Build" };

/** The builder: the questions, their logic, the design, and the form as people see it. */
export default async function BuildPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await formFor((await params).id);
  if (!ctx) return null;
  const { project, form } = ctx;
  let detail: Awaited<ReturnType<typeof formOf>> | null = null;
  let problem: string | null = null;
  try {
    detail = await formOf(project, form.id);
  } catch (err) {
    problem = (err as Error).message;
  }
  return (
    <>
      <PageHeader title={form.title} crumb="Build" meta={<FormStatus form={form} closed={form.closed} />} />
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      {detail && form.closed && (
        <Notice lead="Closed" tone="gold">
          The form isn&apos;t taking answers ({form.closed}): its Settings page opens it again. The preview below shows it anyway.
        </Notice>
      )}
      {detail && <FormBuilder form={detail.form} publicUrl={formsPublicUrl(project)} preview={detail.preview} />}
    </>
  );
}

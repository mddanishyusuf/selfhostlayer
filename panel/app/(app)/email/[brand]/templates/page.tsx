import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { when } from "@/components/email-ui";
import { Icon } from "@/components/icon";
import { CARD, Empty, Notice, PageHeader } from "@/components/page";
import { buttonClass } from "@/components/ui";
import { brandFor, templatesOf, type Template } from "@/lib/email";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Templates" };

export default async function TemplatesPage({ params }: { params: Promise<{ brand: string }> }) {
  await requireUser();
  const ctx = await brandFor((await params).brand);
  if (!ctx) return null;
  const { project, brand } = ctx;
  let templates: Template[] = [];
  let problem: string | null = null;
  try {
    templates = await templatesOf(project, brand.id);
  } catch (err) {
    problem = (err as Error).message;
  }
  return (
    <>
      <PageHeader
        title={brand.name}
        crumb="Templates"
        meta="Emails your app sends through the API, with {{variables}}"
        actions={
          <Link href={`/email/${brand.id}/templates/new`} className={buttonClass()} data-testid="new-template">
            <Icon icon={PlusIcon} size={16} /> New template
          </Link>
        }
      />
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      <section className={CARD} data-testid="templates">
        {templates.length === 0 && !problem && <Empty>No templates yet. With one, your app sends {`{ template: { id, variables } }`} instead of the whole email.</Empty>}
        {templates.map((t) => (
          <Link key={t.id} href={`/email/${brand.id}/templates/${t.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border-soft px-3.5 py-2.5 text-[13px] last:border-b-0 hover:bg-hover">
            <span className="grid min-w-0">
              <b className="truncate font-bold">{t.name}</b>
              <span className="truncate text-[12px] text-muted">{t.subject || "No subject"}</span>
            </span>
            <span className="text-right text-[12px] text-muted">
              id <code className="font-mono">{t.id}</code> · {when(t.updatedAt)}
            </span>
          </Link>
        ))}
      </section>
    </>
  );
}

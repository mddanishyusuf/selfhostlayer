import { ClipboardListIcon } from "lucide-react";
import Link from "next/link";
import { when } from "@/components/email-ui";
import { NewFormButton } from "@/components/forms-forms";
import { FormStatus } from "@/components/forms-ui";
import { Icon } from "@/components/icon";
import { InstallButton } from "@/components/integrations";
import { CARD, Empty, Notice, PageHeader, TileIcon } from "@/components/page";
import { Pill, cx } from "@/components/ui";
import { catalogApps } from "@/lib/catalog";
import { formsInstall, formsPublicUrl, listForms, type Form } from "@/lib/forms";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Forms" };

const GRID = "minmax(0,1.6fr) 130px 100px 140px 70px";

/** Install, or every form with its responses. */
export default async function FormsPage() {
  await requireUser();
  const project = formsInstall();
  if (!project) {
    const app = (await catalogApps().catch(() => [])).find((a) => a.id === "forms");
    const version = app?.versions.find((v) => v.supported);
    return (
      <>
        <PageHeader title="Forms" meta="Forms and surveys on your own server" />
        <section className={cx(CARD, "grid justify-items-center gap-3 px-6 py-12 text-center")}>
          <TileIcon tone="rose">
            <Icon icon={ClipboardListIcon} size={20} />
          </TileIcon>
          <p className="text-[17px] font-bold">Forms like Typeform and Tally, on your own address</p>
          <p className="max-w-[560px] text-muted">
            Contact forms, surveys, signups and applications: a page of questions or one at a time, with logic, ratings, file uploads and hidden fields from the link. Share a link, a QR code, or embed it on any site. Responses
            stay on this server, with emails through Email and signed webhooks.
          </p>
          {version ? <InstallButton app="forms" /> : app ? <Pill outline>Needs {app.versions[0]!.minPanel} or newer</Pill> : <Pill outline>Coming soon to the catalog</Pill>}
        </section>
      </>
    );
  }
  let forms: Form[] = [];
  let problem: string | null = null;
  try {
    forms = await listForms(project);
  } catch (err) {
    problem = (err as Error).message;
  }
  const host = formsPublicUrl(project).replace(/^https?:\/\//, "");
  return (
    <>
      <PageHeader title="Forms" meta={problem ? "Forms and surveys on your own server" : `${forms.length} form${forms.length === 1 ? "" : "s"} at ${host}`} actions={!problem && <NewFormButton />} />
      {problem ? (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      ) : (
        <section className={CARD} data-testid="forms-list">
          <div className="hidden h-9 items-center gap-x-4 border-b border-border px-3.5 text-[12px] text-muted md:grid" style={{ gridTemplateColumns: GRID }}>
            <span>Form</span>
            <span>Layout</span>
            <span className="text-right">Responses</span>
            <span className="text-right">Last response</span>
            <span className="text-right">Status</span>
          </div>
          {forms.length === 0 && <Empty action={<NewFormButton size="sm" />}>No forms yet: start from a template, then change anything in it.</Empty>}
          {forms.map((f) => (
            <Link key={f.id} href={`/forms/${f.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-soft px-3.5 py-2.5 text-[13px] last:border-b-0 hover:bg-hover md:grid" style={{ gridTemplateColumns: GRID }} data-testid="form-row">
              <span className="grid min-w-0 basis-full md:basis-auto">
                <span className="truncate font-bold">{f.title}</span>
                <span className="truncate text-[12px] text-muted">/f/{f.slug}</span>
              </span>
              <span className="text-[12px] text-muted">{f.schema.layout === "conversational" ? "One at a time" : "One page"}</span>
              <span className="tabular-nums md:text-right">{f.responses.toLocaleString("en")}</span>
              <span className="text-[12px] text-muted md:text-right">{when(f.lastResponseAt)}</span>
              <span className="max-md:ml-auto md:justify-self-end">
                <FormStatus form={f} closed={f.closed} />
              </span>
            </Link>
          ))}
        </section>
      )}
    </>
  );
}

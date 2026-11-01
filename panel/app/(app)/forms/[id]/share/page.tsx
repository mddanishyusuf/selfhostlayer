import { CopyLine, QrCode } from "@/components/forms-forms";
import { Notice, PageHeader, Section } from "@/components/page";
import { formFor, formsPublicUrl } from "@/lib/forms";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Share" };

/** The link (filled in ahead with ?field=…), its QR code, and the codes that put the form on another site. */
export default async function SharePage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const ctx = await formFor((await params).id);
  if (!ctx) return null;
  const { project, form } = ctx;
  const base = formsPublicUrl(project);
  const link = `${base}/f/${form.slug}`;
  const hidden = form.schema.fields.filter((f) => f.type === "hidden");
  const fillable = form.schema.fields.find((f) => ["short_text", "email", "choice", "dropdown"].includes(f.type));
  const script = `<script src="${base}/embed.js" async></script>`;
  return (
    <>
      <PageHeader title={form.title} crumb="Share" meta="A link, a QR code, or on your own site" />
      {form.closed && (
        <Notice lead="Closed" tone="gold">
          People who open it now see that it isn&apos;t taking answers ({form.closed}).
        </Notice>
      )}
      <Section title="Link" description="Anyone with it can fill in the form">
        <div className="grid gap-3 border-t border-border px-3.5 py-3.5">
          <CopyLine text={link} testId="share-link" />
          <p className="text-[12px] text-muted">
            Fill answers in ahead with the question&apos;s id in the link{fillable ? <>, like <code className="font-mono">?{fillable.id}=…</code></> : null}
            {hidden.length ? (
              <>
                ; hidden fields take theirs from it too: <code className="font-mono">{hidden.map((f) => `?${f.param || f.id}=…`).join(" ")}</code>
              </>
            ) : null}
            .
          </p>
        </div>
      </Section>
      <Section title="QR code" description="For print: a poster, a flyer, a table at an event">
        <div className="border-t border-border px-3.5 py-3.5">
          <QrCode url={link} name={form.slug} />
        </div>
      </Section>
      <Section title="On your site" description="The script makes the form as tall as its questions, and works on any page">
        <div className="grid gap-4 border-t border-border px-3.5 py-3.5">
          <div className="grid gap-1.5">
            <b className="text-[13px]">In the page</b>
            <CopyLine text={`<div data-shl-form="${form.slug}"></div>\n${script}`} testId="embed-inline" />
          </div>
          <div className="grid gap-1.5">
            <b className="text-[13px]">As a popup from a button</b>
            <CopyLine text={`<button data-shl-form="${form.slug}" data-mode="popup">${form.title.replace(/[<>&"]/g, "")}</button>\n${script}`} testId="embed-popup" />
          </div>
          <div className="grid gap-1.5">
            <b className="text-[13px]">An iframe, without the script</b>
            <CopyLine text={`<iframe src="${link}?embed=1" title="${form.title.replace(/[<>&"]/g, "")}" style="width:100%;height:640px;border:0"></iframe>`} testId="embed-iframe" />
          </div>
        </div>
      </Section>
    </>
  );
}

import { when } from "@/components/email-ui";
import { DeleteFormButton, DuplicateFormButton, EmailConnect, FormSettingsForm, NotifyForm } from "@/components/forms-forms";
import { Notice, PageHeader, SettingsRow } from "@/components/page";
import { cx } from "@/components/ui";
import { emailInstall, listBrands } from "@/lib/email";
import { formFor, formOf, formsPublicUrl, formsSettings } from "@/lib/forms";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Form settings" };

const KINDS = { webhook: "Webhook", email: "Email to you", receipt: "Copy to them" } as const;

export default async function FormSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const ctx = await formFor((await params).id);
  if (!ctx) return null;
  const { project, form } = ctx;
  const email = emailInstall();
  let detail: Awaited<ReturnType<typeof formOf>> | null = null;
  let connected: Awaited<ReturnType<typeof formsSettings>>["email"] = null;
  let problem: string | null = null;
  try {
    [detail, { email: connected }] = await Promise.all([formOf(project, form.id), formsSettings(project)]);
  } catch (err) {
    problem = (err as Error).message;
  }
  // Brands to send through, if Email is here and answering.
  const brands = email && !connected ? await listBrands(email).catch(() => []) : [];
  if (!detail) {
    return (
      <>
        <PageHeader title={form.title} crumb="Settings" />
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      </>
    );
  }
  const f = detail.form;
  const emailFields = f.schema.fields.filter((x) => x.type === "email").map((x) => ({ id: x.id, label: x.label }));
  return (
    <>
      <PageHeader title={form.title} crumb="Settings" meta="Its address, when it closes, and who's told" />
      <SettingsRow title="Answers" description="Close it by hand, at a time, or once enough people answered.">
        <FormSettingsForm form={f} publicUrl={formsPublicUrl(project)} />
      </SettingsRow>
      <SettingsRow id="notify" title="Notifications" description="Each response by email, a copy to the person who sent it, and a webhook for your own code. Tried again for an hour if they fail.">
        <NotifyForm form={f} emailReady={!!connected} emailFields={emailFields} />
        {detail.deliveries.length > 0 && (
          <div className="mt-1 grid border border-border" data-testid="deliveries">
            {detail.deliveries.slice(0, 8).map((d, i) => (
              <div key={i} className="grid grid-cols-[110px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border-soft px-2.5 py-1.5 text-[12px] last:border-b-0">
                <span>{KINDS[d.kind] ?? d.kind}</span>
                <span className={cx("truncate", d.status === "failed" ? "text-err" : "text-muted")} title={d.error ?? undefined}>
                  {d.status === "done" ? (d.error ? `Skipped: ${d.error}` : "Sent") : d.status === "failed" ? `Failed: ${d.error ?? "unknown"}` : d.attempts ? `Trying again: ${d.error ?? ""}` : "Waiting"}
                </span>
                <span className="text-dim">{when(d.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </SettingsRow>
      <SettingsRow title="Sending email" description="Forms sends through the Email integration, as one of its brands. This is for every form.">
        <EmailConnect connected={connected} emailInstalled={!!email} brands={brands.map((b) => ({ id: b.id, name: b.name, from: b.fromEmail }))} />
      </SettingsRow>
      <SettingsRow title="Duplicate" description="A copy of its questions and design, at a new address, with no responses.">
        <DuplicateFormButton id={f.id} />
      </SettingsRow>
      <SettingsRow title="Delete the form" description="Its responses and files go too.">
        <div>
          <DeleteFormButton form={f} />
        </div>
      </SettingsRow>
    </>
  );
}

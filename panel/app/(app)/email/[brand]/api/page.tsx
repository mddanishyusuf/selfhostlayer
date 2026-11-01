import { CreateKeyForm, RevokeKeyButton } from "@/components/email-forms";
import { when } from "@/components/email-ui";
import { CopyButton } from "@/components/form";
import { Empty, Notice, PageHeader, Section } from "@/components/page";
import { brandFor, emailPublicUrl, keysOf, type KeyInfo } from "@/lib/email";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "API" };

export default async function ApiPage({ params }: { params: Promise<{ brand: string }> }) {
  await requireUser();
  const ctx = await brandFor((await params).brand);
  if (!ctx) return null;
  const { project, brand } = ctx;
  let keys: KeyInfo[] = [];
  let problem: string | null = null;
  try {
    keys = await keysOf(project, brand.id);
  } catch (err) {
    problem = (err as Error).message;
  }
  const base = emailPublicUrl(project);
  const from = brand.fromEmail || "hello@example.com";
  const curl = `curl ${base}/emails \\
  -H "Authorization: Bearer em_…" \\
  -H "Content-Type: application/json" \\
  -d '{"from": "${brand.fromName ? `${brand.fromName} <${from}>` : from}", "to": "ada@example.com", "subject": "Your receipt", "html": "<p>Thanks for your order!</p>"}'`;
  const sdk = `import { Resend } from "resend";

// Resend's SDK, pointed at this server.
process.env.RESEND_BASE_URL = "${base}";
const email = new Resend("em_…");

await email.emails.send({
  from: "${from}",
  to: "ada@example.com",
  subject: "Welcome",
  html: "<p>Glad you're here.</p>",
});`;
  return (
    <>
      <PageHeader title={brand.name} crumb="API" meta="Transactional email from your apps: receipts, password resets, alerts" />
      {problem && (
        <Notice lead="Not reachable" tone="err">
          {problem}
        </Notice>
      )}
      <Section title="Keys" description="Each key sends as this brand. It's shown once; only a hash is kept.">
        <div className="border-t border-border p-3.5">
          <CreateKeyForm brandId={brand.id} />
        </div>
        <div className="border-t border-border" data-testid="keys">
          {keys.length === 0 && <Empty>No keys yet.</Empty>}
          {keys.map((k) => (
            <div key={k.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border-soft px-3.5 py-2.5 text-[13px] last:border-b-0">
              <span className="grid min-w-0">
                <b className="truncate font-bold">{k.name}</b>
                <span className="truncate text-[12px] text-muted">
                  <code className="font-mono">{k.prefix}…</code> · made {when(k.createdAt)} · {k.lastUsedAt ? `last used ${when(k.lastUsedAt)}` : "never used"}
                </span>
              </span>
              <RevokeKeyButton brandId={brand.id} id={k.id} name={k.name} />
            </div>
          ))}
        </div>
      </Section>
      <Section title="Send one" description="POST /emails takes Resend's JSON: from, to, subject, html or text, cc, bcc, reply_to, headers, attachments (base64), tags, scheduled_at, or a template with variables">
        <div className="grid gap-3 border-t border-border p-3.5">
          <div className="flex items-start gap-2 bg-well px-3 py-2.5">
            <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-[12px] leading-relaxed">{curl}</pre>
            <CopyButton text={curl} />
          </div>
          <div className="flex items-start gap-2 bg-well px-3 py-2.5">
            <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-[12px] leading-relaxed">{sdk}</pre>
            <CopyButton text={sdk} />
          </div>
          <p className="text-[12px] text-muted">
            Also: POST /emails/batch (up to 100), GET /emails/:id (its status), POST /contacts (add or update a contact, with lists), POST /events (start automations). The From address must be on one of this brand&apos;s verified domains;
            suppressed addresses are left out. At most 20 requests a second per key.
          </p>
        </div>
      </Section>
    </>
  );
}

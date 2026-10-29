import { CalendarClock, ChartColumn, Clock3, Link2, Mail, MessageSquareText, NotebookPen } from "lucide-react";
import { PageBody, PageHeader, Section } from "@/components/page";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Integrations" };

const APPS = [
  { icon: ChartColumn, name: "Analytics", by: "Piqo", what: "Cookie-free web analytics for every project you deploy." },
  { icon: Mail, name: "Email marketing", by: "maillayer", what: "Newsletters and campaigns, sent through your own SMTP or SES." },
  { icon: CalendarClock, name: "Post scheduler", by: "postscheduler", what: "Schedule posts to X, LinkedIn and more." },
  { icon: NotebookPen, name: "Blog", by: "blogcms", what: "A fast blog with an editor, on your own domain." },
  { icon: Link2, name: "Link shortener", by: "Piqo links", what: "Short links with click stats on your domain." },
  { icon: Clock3, name: "Waitlist", by: "Self Host Layer", what: "Collect sign-ups before launch, export any time." },
  { icon: MessageSquareText, name: "Feedback board", by: "Self Host Layer", what: "Let users suggest and vote on features." },
];

export default async function IntegrationsPage() {
  await requireUser();
  return (
    <>
      <PageHeader title="Integrations" subtitle="Tools every product needs, installed on this server in one click" />
      <PageBody>
        <Section title="Coming soon" description="Each one runs like your own apps: sandboxed, backed up, on its own subdomain.">
          <div className="grid gap-3 sm:grid-cols-2">
            {APPS.map(({ icon: Icon, name, by, what }) => (
              <div key={name} className="grid gap-3 rounded-2xl border border-border p-4">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-xl bg-subtle">
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <div className="grid min-w-0">
                    <p className="text-[15px] font-bold">{name}</p>
                    <p className="text-[13px] text-muted">{by}</p>
                  </div>
                  <span className="ml-auto rounded-full border border-border-strong px-2.5 py-0.5 text-[12px] font-bold text-muted">Soon</span>
                </div>
                <p className="text-[14px] text-muted">{what}</p>
              </div>
            ))}
          </div>
        </Section>
      </PageBody>
    </>
  );
}

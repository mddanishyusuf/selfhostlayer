import { Activity01Icon, Analytics01Icon, Calendar03Icon, Clock01Icon, Link01Icon, Mail01Icon, Message01Icon, PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/icon";
import { CARD, Notice, PageHeader, TableHead, TableRow, TileIcon } from "@/components/page";
import { Pill } from "@/components/ui";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Integrations" };

const APPS = [
  { icon: Analytics01Icon, tone: "lav", name: "Analytics", by: "Piqo", what: "Cookie-free web analytics for every project you deploy." },
  { icon: Mail01Icon, tone: "coral", name: "Email marketing", by: "maillayer", what: "Newsletters and campaigns through your own SMTP or SES." },
  { icon: Calendar03Icon, tone: "blue", name: "Post scheduler", by: "postscheduler", what: "Schedule posts to X, LinkedIn and Threads." },
  { icon: PencilEdit01Icon, tone: "teal", name: "Blog", by: "blogcms", what: "A fast blog with an editor, on your own domain." },
  { icon: Link01Icon, tone: "lav", name: "Link shortener", by: "Piqo links", what: "Short links with click stats on your domain." },
  { icon: Activity01Icon, tone: "teal", name: "Status page", by: "Self Host Layer", what: "A public uptime page fed by your apps' health checks." },
  { icon: Clock01Icon, tone: "gold", name: "Waitlist", by: "Self Host Layer", what: "Collect sign-ups before launch and export them any time." },
  { icon: Message01Icon, tone: "coral", name: "Feedback board", by: "Self Host Layer", what: "Let users suggest and vote on features." },
] as const;

export default async function IntegrationsPage() {
  await requireUser();
  const columns = "44px minmax(220px,1fr) 150px 130px";
  return (
    <>
      <PageHeader title="Integrations" meta="Tools every product needs, one click" />
      <Notice lead="Soon" tone="lav">
        Each one will install like your own apps: sandboxed, backed up, on its own subdomain.
      </Notice>
      <section className={CARD}>
        <TableHead columns={columns}>
          <span />
          <span>App</span>
          <span>By</span>
          <span />
        </TableHead>
        {APPS.map((a) => (
          <TableRow key={a.name} columns={columns}>
            <TileIcon tone={a.tone}>
              <Icon icon={a.icon} size={20} />
            </TileIcon>
            <div className="grid min-w-0 flex-1 gap-px">
              <span className="font-medium">{a.name}</span>
              <span className="text-[12.5px] text-muted">{a.what}</span>
            </div>
            <span className="text-muted max-md:hidden">{a.by}</span>
            <span className="justify-self-end max-md:ml-auto">
              <Pill outline>Coming soon</Pill>
            </span>
          </TableRow>
        ))}
      </section>
    </>
  );
}

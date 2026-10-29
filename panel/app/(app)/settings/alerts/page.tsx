import { BellRing, CircleCheck, CircleAlert } from "lucide-react";
import { removeChannelAction, testChannelAction } from "@/app/actions/alerts";
import { AddChannelForm } from "@/components/alerts";
import { SubmitButton } from "@/components/form";
import { timeAgo } from "@/components/status";
import { Card } from "@/components/ui";
import { listChannels, listIncidents } from "@/lib/alerts/engine";
import { PageBody, PageHeader } from "@/components/page";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Alerts" };

const KIND_LABEL = { telegram: "Telegram", discord: "Discord", webhook: "Webhook", email: "Email" } as const;

/** Where a channel sends, without showing secrets. */
function target(c: ReturnType<typeof listChannels>[number]): string {
  if (c.config.kind === "telegram") return `chat ${c.config.chatId}`;
  if (c.config.kind === "discord") return "Discord webhook";
  if (c.config.kind === "email") return `${c.config.to.join(", ")} via ${c.config.host}`;
  return new URL(c.config.url).host + (c.config.secret ? " · signed" : "");
}

export default async function AlertsPage() {
  await requireUser();
  const channels = listChannels();
  const incidents = listIncidents();
  const open = incidents.filter((i) => !i.resolvedAt);
  const resolved = incidents.filter((i) => i.resolvedAt);

  return (
    <>
      <PageHeader
        title="Alerts"
      />
      <PageBody>
        <p className="text-[13px] text-muted">One message when something breaks (a failed deploy, a crash-looping app, disk over 80%, a certificate problem, a failed cron job or backup) and one when it recovers.</p>

      <section className="grid gap-3">
        <h2 className="text-[17px] font-bold tracking-tight">Open incidents</h2>
        <Card className="divide-y divide-border overflow-hidden">
          {open.length === 0 && (
            <p className="flex items-center gap-2 px-5 py-6 text-muted">
              <CircleCheck className="size-4 text-ok" aria-hidden /> Everything looks fine.
            </p>
          )}
          {open.map((i) => (
            <div key={i.id} className="grid gap-1 px-5 py-4">
              <p className="flex items-center gap-2 font-medium">
                <CircleAlert className="size-4 text-err" aria-hidden /> {i.title}
                <span className="ml-auto text-[12px] font-normal text-muted">{timeAgo(i.openedAt)}</span>
              </p>
              {i.detail && <p className="text-[13px] text-muted">{i.detail}</p>}
              {i.link && (
                <a href={i.link} className="text-[13px] underline-offset-4 hover:underline">
                  Open
                </a>
              )}
              {i.notifyErrors && <p className="text-[12px] text-err">Couldn't notify: {i.notifyErrors}</p>}
            </div>
          ))}
        </Card>
      </section>

      <section className="grid gap-3">
        <h2 className="text-[17px] font-bold tracking-tight">Channels</h2>
        {channels.length > 0 && (
          <Card className="divide-y divide-border overflow-hidden">
            {channels.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <BellRing className="size-4 text-muted" aria-hidden />
                <div className="grid min-w-0 flex-1">
                  <p className="font-medium">{c.name}</p>
                  <p className="text-[12px] text-muted">
                    {KIND_LABEL[c.kind]} · {target(c)}
                  </p>
                </div>
                <form action={testChannelAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <SubmitButton pending="Sending…" variant="secondary" className="h-8 w-auto px-3 text-[13px]">
                    Send test
                  </SubmitButton>
                </form>
                <form action={removeChannelAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <button type="submit" className="h-8 rounded-md px-3 text-[13px] text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground">
                    Remove
                  </button>
                </form>
              </div>
            ))}
          </Card>
        )}
        <Card className="p-5">
          <AddChannelForm />
        </Card>
      </section>

      {resolved.length > 0 && (
        <section className="grid gap-3">
          <h2 className="text-[17px] font-bold tracking-tight">Recently resolved</h2>
          <Card className="divide-y divide-border overflow-hidden">
            {resolved.map((i) => (
              <div key={i.id} className="flex items-center gap-3 px-5 py-3 text-[13px]">
                <CircleCheck className="size-4 text-ok" aria-hidden />
                <span className="flex-1">{i.title}</span>
                <span className="text-muted">{timeAgo(i.resolvedAt!)}</span>
              </div>
            ))}
          </Card>
        </section>
      )}
      </PageBody>
    </>
  );
}

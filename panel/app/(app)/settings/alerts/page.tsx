import { Alert02Icon, CheckmarkCircle02Icon, Mail01Icon, Notification01Icon, TelegramIcon } from "@hugeicons/core-free-icons";
import { removeChannelAction, testChannelAction } from "@/app/actions/alerts";
import { AddChannelForm } from "@/components/alerts";
import { SubmitButton } from "@/components/form";
import { Icon } from "@/components/icon";
import { ListRow, PageHeader, RowIcon, Section, SettingsRow } from "@/components/page";
import { StatusText, timeAgo } from "@/components/status";
import { listChannels, listIncidents } from "@/lib/alerts/engine";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Alerts" };

const KIND_LABEL = { telegram: "Telegram", discord: "Discord", webhook: "Webhook", email: "Email" } as const;
const KIND_ICON = { telegram: TelegramIcon, discord: Notification01Icon, webhook: Notification01Icon, email: Mail01Icon } as const;

/** Where a channel sends, without showing secrets. */
function target(c: ReturnType<typeof listChannels>[number]): string {
  if (c.config.kind === "telegram") return `chat ${c.config.chatId}`;
  if (c.config.kind === "discord") return "Discord webhook";
  if (c.config.kind === "email") return `${c.config.to.join(", ")} via ${c.config.host}`;
  return new URL(c.config.url).host + (c.config.secret ? " · signed" : "");
}

const WATCHING = [
  ["Deploy failed", "Any project; the live version keeps serving."],
  ["App crash-looping", "3+ restarts between checks, or systemd gave up."],
  ["Disk over 80%", "Recovers below 75%."],
  ["Certificate problems", "Expired, under 14 days left, or stuck issuing."],
  ["Cron job failed", "Any job's last run."],
  ["Backup failed or late", "No successful backup in 26 hours."],
];

export default async function AlertsPage() {
  await requireUser();
  const channels = listChannels();
  const incidents = listIncidents();
  const open = incidents.filter((i) => !i.resolvedAt);
  const resolved = incidents.filter((i) => i.resolvedAt).slice(0, 8);

  return (
    <>
      <PageHeader title="Alerts" meta="One message when something breaks, one when it recovers" />

      <Section title="Open">
        {open.length === 0 ? (
          <ListRow lead={<RowIcon tone="ok"><Icon icon={CheckmarkCircle02Icon} size={17} /></RowIcon>} title={<span className="font-medium">Everything looks fine.</span>} sub="Nothing is broken right now." />
        ) : (
          open.map((i) => (
            <ListRow
              key={i.id}
              highlight
              lead={<RowIcon tone="warn"><Icon icon={Alert02Icon} size={17} /></RowIcon>}
              title={<span className="truncate">{i.title}</span>}
              sub={i.notifyErrors ? <span className="text-rose">Couldn&apos;t notify: {i.notifyErrors}</span> : <span className="truncate">{i.detail}</span>}
              side={
                <>
                  <span className="whitespace-nowrap text-[13px] text-muted">{timeAgo(i.openedAt)}</span>
                  {i.link && (
                    <a href={i.link} className="text-[13px] text-lavender hover:underline">
                      Open
                    </a>
                  )}
                </>
              }
            />
          ))
        )}
      </Section>

      <Section title="Channels" description="Where alerts go.">
        {channels.length === 0 && <ListRow title={<span className="font-medium text-muted">No channels yet</span>} sub="Add one below: Telegram, Discord, a webhook or email." />}
        {channels.map((c) => (
          <ListRow
            key={c.id}
            lead={<RowIcon><Icon icon={KIND_ICON[c.kind]} size={17} /></RowIcon>}
            title={<span className="truncate">{c.name}</span>}
            sub={
              <span className="truncate">
                {KIND_LABEL[c.kind]} · {target(c)}
              </span>
            }
            side={
              <>
                <form action={testChannelAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <SubmitButton pending="Sending…" variant="secondary" size="sm" className="w-auto">
                    Send test
                  </SubmitButton>
                </form>
                <form action={removeChannelAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <SubmitButton pending="Removing…" variant="ghost" size="sm" className="w-auto">
                    Remove
                  </SubmitButton>
                </form>
              </>
            }
          />
        ))}
      </Section>

      <SettingsRow title="Add a channel" description="Telegram, Discord, a webhook or email. Saving sends a test message right away.">
        <AddChannelForm />
      </SettingsRow>

      <Section title="Watching" description="What raises an alert. Checked every minute.">
        {WATCHING.map(([title, detail]) => (
          <ListRow key={title} title={<span className="font-medium">{title}</span>} sub={detail} side={<StatusText status="ok" label="On" />} />
        ))}
      </Section>

      {resolved.length > 0 && (
        <Section title="Recently resolved">
          {resolved.map((i) => (
            <ListRow key={i.id} lead={<span className="text-teal"><Icon icon={CheckmarkCircle02Icon} size={16} /></span>} title={<span className="truncate font-normal text-muted">{i.title}</span>} side={<span className="whitespace-nowrap text-[13px] text-dim">{timeAgo(i.resolvedAt!)}</span>} className="py-3" />
          ))}
        </Section>
      )}
    </>
  );
}

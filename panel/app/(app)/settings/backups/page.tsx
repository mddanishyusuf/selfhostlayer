import { DatabaseRestoreIcon, Key01Icon } from "@hugeicons/core-free-icons";
import { backUpEverythingAction, confirmRecoveryKeyAction, saveScheduleAction } from "@/app/actions/backups";
import { BackupList, formatBytes } from "@/components/backup-list";
import { DestinationForm, RefreshWhile, TestConnectionButton } from "@/components/backups";
import { CopyButton, SubmitButton } from "@/components/form";
import { Icon } from "@/components/icon";
import { KeyValues, Notice, PageHeader, Section, SettingsRow } from "@/components/page";
import { Select } from "@/components/ui";
import { listBackups } from "@/lib/backup/runner";
import { getBackupSettings, PROVIDERS } from "@/lib/backup/settings";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Backups" };

const providers = Object.entries(PROVIDERS).map(([id, p]) => ({ id, ...p }));
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

export default async function BackupsPage() {
  await requireUser();
  const settings = getBackupSettings();
  const d = settings?.destination;
  const backups = settings ? listBackups({ limit: 20 }) : [];
  // The latest run: everything that started within an hour of the newest backup.
  const newest = backups.find((b) => b.status !== "running");
  const run = newest ? backups.filter((b) => b.status !== "running" && newest.startedAt - b.startedAt < 3600_000) : [];
  const failed = run.filter((b) => b.status === "failed");
  const bytes = run.reduce((n, b) => n + (b.bytes ?? 0), 0);

  return (
    <>
      <RefreshWhile active={backups.some((b) => b.status === "running")} />
      <PageHeader
        title="Backups"
        meta="Encrypted on this server before upload"
        actions={
          settings?.keyConfirmed && (
            <form action={backUpEverythingAction}>
              <SubmitButton pending="Starting…" variant="secondary" className="w-auto">
                Back up everything now
              </SubmitButton>
            </form>
          )
        }
      />
      {!settings ? (
        <Notice lead="Off">Connect an S3-compatible bucket below to back up every app and the panel each night.</Notice>
      ) : !settings.keyConfirmed ? (
        <Notice lead="Almost there">Save the recovery key below to turn backups on.</Notice>
      ) : newest ? (
        <Notice lead={failed.length ? `${failed.length} failed` : "Last run"} tone={failed.length ? "gold" : "ok"}>
          {run.length - failed.length} of {run.length} backed up to {PROVIDERS[settings.provider].label} ({formatBytes(bytes)}).
          {failed.length > 0 && ` ${failed.map((b) => (b.kind === "panel" ? "The panel" : b.slug)).join(", ")}: ${failed[0]!.error}`}
        </Notice>
      ) : (
        <Notice lead="On" tone="ok">
          The first backup runs at {hourLabel(settings.scheduleHour)}, or press Back up everything now.
        </Notice>
      )}

      {settings && !settings.keyConfirmed && (
        <SettingsRow id="recovery-key" title={<span className="flex items-center gap-2"><Icon icon={Key01Icon} size={16} /> Save your recovery key</span>} description="Backups are encrypted with this key before they leave the server. If this server is lost, you need it to restore anything. It won't be shown again.">
          <div className="flex items-center justify-between gap-3 border-l-2 border-gold bg-gold/7 px-4 py-3">
            <code className="break-all font-mono text-[13px]" data-testid="recovery-key">
              {settings.recoveryKey}
            </code>
            <CopyButton text={settings.recoveryKey} />
          </div>
          <form action={confirmRecoveryKeyAction} className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-[13.5px]">
              <input type="checkbox" name="saved" required className="size-4 accent-[var(--lavender)]" /> I saved it somewhere other than this server
            </label>
            <SubmitButton pending="Saving…" className="w-auto">
              Turn on backups
            </SubmitButton>
          </form>
        </SettingsRow>
      )}

      {settings && d && (
        <SettingsRow title="Storage" description="Your own S3-compatible bucket. Backups are encrypted with your recovery key first.">
          <KeyValues
            inset
            items={[
              ["Provider", PROVIDERS[settings.provider].label],
              ["Bucket", <code key="b" className="font-mono text-[13.5px]">{d.bucket}</code>],
              ["Endpoint", <span key="e" className="truncate">{new URL(d.endpoint).host}</span>],
              ...(d.prefix ? ([["Folder", <code key="f" className="font-mono text-[13.5px]">{d.prefix}</code>]] as [string, React.ReactNode][]) : []),
              ["Recovery key", settings.keyConfirmed ? "Saved (shown only once)" : "Not saved yet"],
            ]}
          />
          <div className="flex flex-wrap items-center gap-2">
            <TestConnectionButton />
            <a href="#change-storage" className="text-[13px] text-lavender hover:underline">
              Change storage
            </a>
          </div>
        </SettingsRow>
      )}

      {settings?.keyConfirmed && (
        <SettingsRow title="Schedule" description="Once a day, at a quiet hour. Old backups are deleted past the count you keep.">
          <form action={saveScheduleAction} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <label className="grid gap-1.5 text-[13px] font-medium">
              Every day at
              <Select name="hour" defaultValue={settings.scheduleHour}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </Select>
            </label>
            <label className="grid gap-1.5 text-[13px] font-medium">
              Keep the last (per app)
              <input name="keep" type="number" min={1} max={365} defaultValue={settings.keep} className="h-[38px] rounded-lg border border-border-strong bg-transparent px-3 text-sm tabular-nums outline-none focus:border-lavender" />
            </label>
            <SubmitButton pending="Saving…" variant="secondary" className="w-auto">
              Save
            </SubmitButton>
            <p className="text-[12.5px] text-dim sm:col-span-3">Server time ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</p>
          </form>
        </SettingsRow>
      )}

      {settings?.keyConfirmed && (
        <Section title={<span className="flex items-center gap-2"><Icon icon={DatabaseRestoreIcon} size={16} /> Recent backups</span>}>
          <BackupList backups={backups} showApp empty="No backups yet. The first run is at the scheduled time." />
        </Section>
      )}

      <SettingsRow id="change-storage" title={settings ? "Change storage" : "Connect storage"} description="Any S3-compatible bucket: Cloudflare R2, Backblaze B2, AWS S3, Hetzner and others. Saving tests the connection first.">
        <DestinationForm providers={providers} saved={d ? { provider: settings!.provider, endpoint: d.endpoint, region: d.region, bucket: d.bucket, accessKeyId: d.accessKeyId, prefix: d.prefix } : null} />
      </SettingsRow>
    </>
  );
}

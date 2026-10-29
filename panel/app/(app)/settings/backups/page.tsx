import { KeyRound } from "lucide-react";
import { backUpEverythingAction, confirmRecoveryKeyAction, saveScheduleAction } from "@/app/actions/backups";
import { BackupList } from "@/components/backup-list";
import { DestinationForm, RefreshWhile, TestConnectionButton } from "@/components/backups";
import { CopyButton, SubmitButton } from "@/components/form";
import { Card } from "@/components/ui";
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

  return (
    <div className="mx-auto grid max-w-[760px] gap-6">
      <RefreshWhile active={backups.some((b) => b.status === "running")} />
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Backups</h1>
        <p className="text-muted">
          Every app&apos;s data folder (SQLite copied safely and checked), encrypted on this server and sent to your own S3-compatible bucket. The panel itself is backed up too.
        </p>
      </header>

      {settings && !settings.keyConfirmed && (
        <Card className="grid gap-4 border-warn/40 p-5" id="recovery-key">
          <div className="grid gap-1">
            <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
              <KeyRound className="size-4" aria-hidden /> Save your recovery key
            </h2>
            <p className="text-[13px] text-muted">
              Backups are encrypted with this key before they leave the server. If this server is lost, you need it to restore anything. Keep it in a password manager, not on this server. It won&apos;t be shown again.
            </p>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-subtle px-3 py-2.5">
            <code className="break-all font-mono text-[13px]" data-testid="recovery-key">
              {settings.recoveryKey}
            </code>
            <CopyButton text={settings.recoveryKey} />
          </div>
          <form action={confirmRecoveryKeyAction} className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" name="saved" required className="size-4 accent-foreground" /> I saved it somewhere other than this server
            </label>
            <SubmitButton pending="Saving…" className="w-auto">
              Turn on backups
            </SubmitButton>
          </form>
        </Card>
      )}

      {settings && d && (
        <section className="grid gap-3">
          <h2 className="text-base font-semibold tracking-tight">Storage</h2>
          <Card className="flex flex-wrap items-center gap-3 px-5 py-4">
            <div className="grid min-w-0 flex-1">
              <p className="font-medium">
                {PROVIDERS[settings.provider].label} · <span className="font-mono text-[13px]">{d.bucket}</span>
              </p>
              <p className="truncate text-[12px] text-muted">
                {new URL(d.endpoint).host}
                {d.prefix && ` · ${d.prefix}`}
              </p>
            </div>
            <TestConnectionButton />
          </Card>
        </section>
      )}

      {settings?.keyConfirmed && (
        <section className="grid gap-3">
          <h2 className="text-base font-semibold tracking-tight">Schedule</h2>
          <Card className="p-5">
            <form action={saveScheduleAction} className="flex flex-wrap items-end gap-4">
              <label className="grid gap-1.5 text-[13px] font-medium">
                Every day at
                <select name="hour" defaultValue={settings.scheduleHour} className="h-9 rounded-md border border-border bg-background px-2 text-sm tabular-nums">
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 text-[13px] font-medium">
                Keep the last
                <span className="flex items-center gap-2">
                  <input name="keep" type="number" min={1} max={365} defaultValue={settings.keep} className="h-9 w-20 rounded-md border border-border bg-background px-2 text-sm tabular-nums" />
                  <span className="font-normal text-muted">per app</span>
                </span>
              </label>
              <SubmitButton pending="Saving…" variant="secondary" className="w-auto">
                Save
              </SubmitButton>
              <p className="basis-full text-[12px] text-muted">Server time ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</p>
            </form>
          </Card>
        </section>
      )}

      {settings?.keyConfirmed && (
        <section className="grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold tracking-tight">Recent backups</h2>
            <form action={backUpEverythingAction}>
              <SubmitButton pending="Starting…" variant="secondary" className="h-8 w-auto px-3 text-[13px]">
                Back up everything now
              </SubmitButton>
            </form>
          </div>
          <BackupList backups={backups} showApp empty="No backups yet. The first run is at the scheduled time." />
        </section>
      )}

      <section className="grid gap-3">
        <h2 className="text-base font-semibold tracking-tight">{settings ? "Change storage" : "Connect storage"}</h2>
        <Card className="p-5">
          <DestinationForm
            providers={providers}
            saved={d ? { provider: settings!.provider, endpoint: d.endpoint, region: d.region, bucket: d.bucket, accessKeyId: d.accessKeyId, prefix: d.prefix } : null}
          />
        </Card>
      </section>
    </div>
  );
}

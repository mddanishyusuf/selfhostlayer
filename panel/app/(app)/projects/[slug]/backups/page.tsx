import Link from "next/link";
import { notFound } from "next/navigation";
import { backUpProjectAction } from "@/app/actions/backups";
import { BackupList } from "@/components/backup-list";
import { RefreshWhile } from "@/components/backups";
import { SubmitButton } from "@/components/form";
import { listBackups } from "@/lib/backup/runner";
import { getBackupSettings } from "@/lib/backup/settings";
import { getProjectBySlug } from "@/lib/projects";
import { PageBody, PageHeader } from "@/components/page";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Backups" };

export default async function ProjectBackupsPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project) notFound();
  const settings = getBackupSettings();
  const ready = !!settings?.keyConfirmed;
  const backups = listBackups({ slug: project.slug });
  const running = backups.some((b) => b.status === "running");

  return (
    <>
      <RefreshWhile active={running} />
      <PageHeader
        title="Backups"
        subtitle={project.slug}
        actions={
          ready && (
            <form action={backUpProjectAction}>
              <input type="hidden" name="slug" value={project.slug} />
              <SubmitButton pending="Starting…" className="w-auto">
                Back up now
              </SubmitButton>
            </form>
          )
        }
      />
      <PageBody>
        <p className="text-[13px] text-muted">
          Everything in <code className="font-mono">DATA_DIR</code> ({`/srv/apps/${project.slug}/data`}): SQLite databases copied safely and checked, uploads, Redis data, and a dump of the app&apos;s Postgres.
          {ready && ` Daily at ${String(settings!.scheduleHour).padStart(2, "0")}:00, keeping the last ${settings!.keep}.`}
        </p>
      {!ready && (
        <p className="rounded-md border border-border px-5 py-4 text-[13px]">
          Backups aren&apos;t set up yet.{" "}
          <Link href="/settings/backups" className="font-medium underline underline-offset-4">
            Connect a storage bucket
          </Link>{" "}
          to turn them on for every app.
        </p>
      )}
      <BackupList backups={backups} restorable empty={ready ? "No backups yet. The first one runs at the scheduled time, or press Back up now." : "No backups yet."} />
      </PageBody>
    </>
  );
}

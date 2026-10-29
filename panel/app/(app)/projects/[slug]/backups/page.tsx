import Link from "next/link";
import { notFound } from "next/navigation";
import { backUpProjectAction } from "@/app/actions/backups";
import { BackupList } from "@/components/backup-list";
import { RefreshWhile } from "@/components/backups";
import { SubmitButton } from "@/components/form";
import { Notice, PageHeader } from "@/components/page";
import { listBackups } from "@/lib/backup/runner";
import { getBackupSettings } from "@/lib/backup/settings";
import { getProjectBySlug } from "@/lib/projects";
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

  return (
    <>
      <RefreshWhile active={backups.some((b) => b.status === "running")} />
      <PageHeader
        title={project.slug}
        crumb="Backups"
        meta={ready ? `Daily at ${String(settings!.scheduleHour).padStart(2, "0")}:00 · keep ${settings!.keep}` : undefined}
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
      {ready ? (
        <Notice lead="Included" tone="lav">
          everything in <code className="font-mono text-[13px]">/srv/apps/{project.slug}/data</code> (DATA_DIR): SQLite copied safely and checked, uploads, Redis data, and a dump of its Postgres.
        </Notice>
      ) : (
        <Notice lead="Off">
          Backups aren&apos;t set up yet.{" "}
          <Link href="/settings/backups" className="text-lavender hover:underline">
            Connect a storage bucket
          </Link>{" "}
          to turn them on for every app.
        </Notice>
      )}
      <section className="border-b border-border">
        <BackupList backups={backups} restorable empty={ready ? "No backups yet. The first one runs at the scheduled time, or press Back up now." : "No backups yet."} />
      </section>
    </>
  );
}

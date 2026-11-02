import { notFound } from "next/navigation";
import { AnalyticsSettingsForm } from "@/components/analytics-forms";
import { EmailSettingsForm } from "@/components/email-forms";
import { UpdateButton } from "@/components/integrations";
import { LinksSettingsForm } from "@/components/links";
import { DeleteProject, IntegrationSettingsForm, SettingsForm } from "@/components/settings";
import { Notice, PageHeader, SettingsRow } from "@/components/page";
import { analyticsApi, type AnalyticsSettings } from "@/lib/analytics";
import { catalogApps, updateFor } from "@/lib/catalog";
import { frameworkLabel } from "@/lib/detect";
import { installedVersion, listDeployments } from "@/lib/deploy";
import { emailApi } from "@/lib/email";
import { isLinks, linksApi, shortDomain, type LinksSettings } from "@/lib/links";
import { getProjectBySlug, projectEnv } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: `${(await params).slug} settings` };
}

export default async function SettingsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ new?: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project) notFound();
  if (project.source === "catalog") {
    // An integration's manifest decides how it builds and runs; its memory limit is the owner's.
    const version = installedVersion(project.id);
    const name = version?.manifest?.name ?? project.slug;
    // Links keeps its own settings; they show when it's running.
    const links = isLinks(project) ? await linksApi<LinksSettings>(project, "settings").catch(() => null) : null;
    const analytics = project.catalogApp === "analytics" ? await analyticsApi<AnalyticsSettings>(project, "settings").catch(() => null) : null;
    const email = project.catalogApp === "email" ? await emailApi<{ keepBodiesDays: number; keepDays: number }>(project, "settings").catch(() => null) : null;
    const app = (await catalogApps().catch(() => [])).find((a) => a.id === project.catalogApp);
    const update = updateFor(version?.version, app);
    return (
      <>
        <PageHeader title={project.slug} crumb="Settings" meta={`${version?.commitMessage ?? name}, from the catalog`} />
        <SettingsRow title="Version" description="Updates come from the Self Host Layer catalog. An update backs the data up first when backups are on, and starts beside the old version, so nothing goes down.">
          <div className="flex flex-wrap items-center justify-between gap-3" data-testid="integration-version">
            <span>
              {version?.commitMessage ?? name}
              {!update && <span className="text-muted"> · the newest</span>}
            </span>
            {update && <UpdateButton slug={project.slug} version={update.version} size="md" />}
          </div>
          {update?.notes && <p className="text-[12px] text-muted">New in {update.version}: {update.notes}</p>}
        </SettingsRow>
        {links && <LinksSettingsForm slug={project.slug} domain={shortDomain(project)} settings={links} />}
        {analytics && <AnalyticsSettingsForm keepDays={analytics.keepDays} />}
        {email && (
          <SettingsRow title="Email" description="How long the logs keep what was sent, for every brand. The daily clean-up uses it.">
            <EmailSettingsForm keepBodiesDays={email.keepBodiesDays} keepDays={email.keepDays} />
          </SettingsRow>
        )}
        <IntegrationSettingsForm slug={project.slug} name={name} memoryMb={project.memoryMb} min={version?.manifest?.memory.min ?? 64} />
        <DeleteProject slug={project.slug} integration={name} />
      </>
    );
  }
  const isNew = (await searchParams).new === "1" && listDeployments(project.id, 1).length === 0;
  const r = project.runtime;

  return (
    <>
      <PageHeader
        title={isNew ? `Configure ${project.slug}` : project.slug}
        crumb={isNew ? undefined : "Settings"}
        back={isNew ? "/" : undefined}
        meta={`${frameworkLabel(project.framework)} detected`}
      />
      {isNew && (
        <Notice lead="Almost live" tone="lav">
          Check what we detected, add the env vars it needs, then deploy. It will be live at <b className="font-medium text-foreground">{project.domains[0]}</b>.
        </Notice>
      )}
      <SettingsForm
        isNew={isNew}
        framework={frameworkLabel(project.framework)}
        d={{
          slug: project.slug,
          repo: `${project.repoOwner}/${project.repoName}${project.rootDir ? ` · ${project.rootDir}` : ""}`,
          branch: project.branch,
          installCommand: project.installCommand ?? "",
          buildCommand: project.buildCommand ?? "",
          runtime: r.kind === "static" ? "static" : "node",
          startCommand: r.kind === "node" ? r.exec.join(" ") : "node server.js",
          healthPath: r.kind === "node" ? r.healthPath : "/",
          writablePaths: r.kind === "node" ? r.writablePaths.join(", ") : "",
          outputDir: r.kind === "static" ? r.outputDir : "dist",
          spa: r.kind === "static" ? r.spa : true,
          nodeVersion: project.nodeVersion,
          memoryMb: project.memoryMb,
          packageManager: project.packageManager,
          env: Object.entries(projectEnv(project.id)),
        }}
      />
      {!isNew && <DeleteProject slug={project.slug} />}
    </>
  );
}

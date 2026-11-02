import { ArrowUpRightIcon } from "lucide-react";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { forgetPasswordAction } from "@/app/actions/sites";
import { Icon } from "@/components/icon";
import { CARD, KeyValues, Notice, PageHeader, PillLink, SettingsRow } from "@/components/page";
import { Secret, SiteButton } from "@/components/site-forms";
import { EngineTile } from "@/components/sites";
import { Button, Pill, Skeleton } from "@/components/ui";
import { agent } from "@/lib/agent";
import { listDeployments, liveDeployment } from "@/lib/deploy";
import { servingConfig } from "@/lib/domains";
import { getProjectBySlug, type Project } from "@/lib/projects";
import { requireUser } from "@/lib/session";
import { ENGINES, engineOf, getSite } from "@/lib/sites";

export const dynamic = "force-dynamic";
export const metadata = { title: "Site" };

interface WpStatus {
  version: string | null;
  coreUpdate: string | null;
  plugins: { name: string; title: string; status: string; version: string; update: string | null }[];
  themes: { name: string; title: string; status: string; version: string; update: string | null }[];
  locked: boolean;
  xmlrpc: boolean;
  php: string | null;
}

/** WordPress's own state, asked of the site (and wordpress.org, for updates). */
async function WordpressDetails({ project }: { project: Project }) {
  const s = await agent<WpStatus>("wordpress.status", { slug: project.slug }).catch((err: Error) => err);
  if (s instanceof Error) return <SettingsRow title="WordPress">Couldn&apos;t read the site: {s.message}</SettingsRow>;
  const pluginUpdates = s.plugins.filter((p) => p.update);
  const themeUpdates = s.themes.filter((t) => t.update);
  return (
    <>
      <SettingsRow title="WordPress" description={`Minor releases install themselves. Updates from here are backed up first when backups are on.`}>
        <KeyValues
          inset
          items={[
            ["Version", <span key="v">{s.version ?? "—"} {s.coreUpdate ? <Pill>{s.coreUpdate} available</Pill> : <Pill outline>up to date</Pill>}</span>],
            ["PHP", s.php ?? "—"],
            ["Plugins", `${s.plugins.filter((p) => p.status !== "must-use").length}${pluginUpdates.length ? `, ${pluginUpdates.length} with an update` : ""}`],
            ["Themes", `${s.themes.length}${themeUpdates.length ? `, ${themeUpdates.length} with an update` : ""}`],
          ]}
        />
        <div className="flex flex-wrap gap-2">
          {s.coreUpdate && <SiteButton slug={project.slug} op="update-core" label={`Update to ${s.coreUpdate}`} pending="Updating…" variant="primary" />}
          {pluginUpdates.length > 0 && <SiteButton slug={project.slug} op="update-plugins" label="Update plugins" pending="Updating…" />}
          {themeUpdates.length > 0 && <SiteButton slug={project.slug} op="update-themes" label="Update themes" pending="Updating…" />}
        </div>
      </SettingsRow>
      <SettingsRow title="Lock code" description="Locked, wp-admin can't install or update plugins, themes or WordPress: for a site that's done. Updates from here still work.">
        <div className="flex items-center gap-3">
          {s.locked ? <Pill>Locked</Pill> : <Pill outline>Unlocked</Pill>}
          <SiteButton slug={project.slug} op={s.locked ? "unlock" : "lock"} label={s.locked ? "Unlock" : "Lock code"} pending="Saving…" />
        </div>
      </SettingsRow>
      <SettingsRow title="XML-RPC" description="Off by default: an old way in that password guessers love. Turn it on only for an app that needs it (the WordPress mobile app, Jetpack).">
        <div className="flex items-center gap-3">
          {s.xmlrpc ? <Pill>On</Pill> : <Pill outline>Off</Pill>}
          <SiteButton slug={project.slug} op={s.xmlrpc ? "xmlrpc-off" : "xmlrpc-on"} label={s.xmlrpc ? "Turn off" : "Turn on"} pending="Saving…" />
        </div>
      </SettingsRow>
      <SettingsRow title="A new password" description="For the owner's account, if it's lost. Shown once.">
        <SiteButton slug={project.slug} op="reset-password" label="Make a new password" pending="Making…" />
      </SettingsRow>
    </>
  );
}

interface GhostLatest {
  version: string;
}

/** Ghost's newest version on npm, for Update. */
async function GhostDetails({ project, version }: { project: Project; version: string | null }) {
  const latest = await fetch("https://registry.npmjs.org/ghost/latest", { signal: AbortSignal.timeout(8000), next: { revalidate: 3600 } })
    .then((r) => (r.ok ? (r.json() as Promise<GhostLatest>) : null))
    .catch(() => null);
  const newer = latest && version && latest.version !== version && latest.version.split(".")[0] === version.split(".")[0] ? latest.version : null;
  const major = latest && version && latest.version.split(".")[0] !== version.split(".")[0] ? latest.version : null;
  return (
    <SettingsRow title="Ghost" description="An update is backed up first (when backups are on), then installed beside the running version; Ghost stops for a moment while it moves its database.">
      <KeyValues inset items={[["Version", <span key="v">{version ?? "—"} {newer ? <Pill>{newer} available</Pill> : major ? <Pill>{major}: a new major</Pill> : <Pill outline>up to date</Pill>}</span>]]} />
      <div className="flex flex-wrap gap-2">
        {newer && <SiteButton slug={project.slug} op="update" label={`Update to ${newer}`} pending="Starting…" variant="primary" extra={{ version: newer }} />}
        {major && <SiteButton slug={project.slug} op="update" label={`Update to ${major}`} pending="Starting…" extra={{ version: major }} />}
      </div>
      <p className="text-[12px] text-muted">
        Ghost sends sign-in and invite emails by SMTP and newsletters through Mailgun: both are set in Ghost&apos;s own settings (Settings → Email newsletter), and SMTP here soon.
      </p>
    </SettingsRow>
  );
}

export default async function SitePage({ params }: { params: Promise<{ slug: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  const engine = project && engineOf(project);
  if (!project || !engine) notFound();
  const site = getSite(project.id);
  const live = liveDeployment(project.id);
  const latest = listDeployments(project.id, 1)[0];
  const version = listDeployments(project.id, 30).find((d) => d.version && d.status === "ready")?.version ?? null;
  const hosts = servingConfig(project.id).domains;
  const host = hosts.find((h) => h !== project.domains[0]) ?? hosts[0] ?? project.domains[0];
  const info = ENGINES[engine];
  return (
    <>
      <PageHeader
        title={project.slug}
        crumb={info.name}
        meta={site?.title}
        actions={
          live && host ? (
            <>
              <PillLink href={`https://${host}`} external>
                Open site <Icon icon={ArrowUpRightIcon} size={14} />
              </PillLink>
              <PillLink href={`https://${host}${info.adminPath}`} external primary>
                {engine === "wordpress" ? "wp-admin" : "Ghost admin"} <Icon icon={ArrowUpRightIcon} size={14} />
              </PillLink>
            </>
          ) : undefined
        }
      />
      {!live && latest && (
        <Notice lead={latest.status === "failed" ? "Failed" : "Installing"} tone={latest.status === "failed" ? "err" : undefined}>
          {latest.status === "failed" ? `The last deploy failed: ${latest.error ?? "see its log"}.` : `${info.name} is being installed.`}{" "}
          <a href={`/projects/${project.slug}/deployments/${latest.id}`} className="text-accent hover:underline">
            See the log
          </a>
        </Notice>
      )}
      {site?.password && (
        <section className={CARD}>
          <SettingsRow title="The owner's password" description="Shown this once: keep it in your password manager, then forget it here.">
            <KeyValues
              inset
              items={[
                ["Sign in at", host ? <a key="a" href={`https://${host}${engine === "wordpress" ? "/wp-login.php" : "/ghost/"}`} className="text-accent hover:underline">{`https://${host}${engine === "wordpress" ? "/wp-login.php" : "/ghost/"}`}</a> : "—"],
                [engine === "wordpress" ? "Username" : "Email", engine === "wordpress" ? site.ownerEmail.split("@")[0]!.replace(/[^A-Za-z0-9._-]/g, "") : site.ownerEmail],
                ["Password", <Secret key="p" value={site.password} />],
              ]}
            />
            <form action={forgetPasswordAction}>
              <input type="hidden" name="slug" value={project.slug} />
              <Button type="submit" variant="secondary" size="sm">
                I&apos;ve saved it
              </Button>
            </form>
          </SettingsRow>
        </section>
      )}
      <section className={CARD}>
        <SettingsRow title="Site" description={info.about}>
          <div className="flex items-center gap-3">
            <EngineTile engine={engine} />
            <KeyValues
              inset
              items={[
                ["Address", host ?? "—"],
                ["Owner", site ? `${site.ownerName} (${site.ownerEmail})` : "—"],
              ]}
            />
          </div>
        </SettingsRow>
        {live && (
          <Suspense fallback={<SettingsRow title={info.name}><Skeleton className="h-16" /></SettingsRow>}>
            {engine === "wordpress" ? <WordpressDetails project={project} /> : <GhostDetails project={project} version={version} />}
          </Suspense>
        )}
      </section>
    </>
  );
}

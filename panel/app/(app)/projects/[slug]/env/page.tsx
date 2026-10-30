import { notFound } from "next/navigation";
import { KeyValues, PageHeader, SettingsRow } from "@/components/page";
import { SecretUrl } from "@/components/services";
import { EnvForm } from "@/components/settings";
import { Pill } from "@/components/ui";
import { liveDeployment } from "@/lib/deploy";
import { getProjectBySlug, projectEnv } from "@/lib/projects";
import { serviceStatus } from "@/lib/services";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Environment" };

/** A database URL: masked, with where it comes from. The label is as tall as the box, so they line up. */
const secretRow = (name: string, url: string, source: string): [React.ReactNode, React.ReactNode] => [
  <span key={name} className="flex h-[38px] items-center">
    <code className="font-mono text-[13px]">{name}</code>
  </span>,
  <span key={`${name}-v`} className="flex items-center gap-2.5">
    <span className="min-w-0 flex-1">
      <SecretUrl url={url} />
    </span>
    <Pill outline>{source}</Pill>
  </span>,
];

export default async function EnvPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireUser();
  const project = getProjectBySlug((await params).slug);
  if (!project) notFound();
  const isStatic = project.runtime.kind === "static";
  const status = isStatic ? null : await serviceStatus(project.slug).catch(() => null);
  const provided: [React.ReactNode, React.ReactNode][] = isStatic
    ? []
    : [
        [<code key="d" className="font-mono text-[13px]">DATA_DIR</code>, <code key="dv" className="font-mono text-[13px]">/srv/apps/{project.slug}/data</code>],
        [<code key="p" className="font-mono text-[13px]">PORT, HOST</code>, <span key="pv">127.0.0.1 and the port of the live color (blue or green)</span>],
        ...(status?.redis ? [secretRow("REDIS_URL", status.redis.url, "Redis")] : []),
        ...(status?.postgres ? [secretRow("DATABASE_URL", status.postgres.url, "Postgres")] : []),
        ...(status?.mysql ? [secretRow("DATABASE_URL", status.mysql.url, "MySQL")] : []),
        ...(status?.mongodb ? [secretRow("MONGODB_URI", status.mongodb.url, "MongoDB")] : []),
      ];

  return (
    <>
      <PageHeader title={project.slug} crumb="Environment" meta="Encrypted · only the app's process sees them" />
      <EnvForm slug={project.slug} initial={Object.entries(projectEnv(project.id))} isStatic={isStatic} live={!!liveDeployment(project.id)} />
      {provided.length > 0 && (
        <SettingsRow title="Set for you" description="The server sets these. Databases update their own URLs when you add or remove them.">
          <KeyValues inset items={provided} />
        </SettingsRow>
      )}
    </>
  );
}

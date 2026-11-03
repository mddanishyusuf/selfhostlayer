import { ServerIcon } from "lucide-react";
import { Icon } from "@/components/icon";
import { KeyValues, Notice, PageHeader, Section, SettingsRow, TileIcon } from "@/components/page";
import { AddServerForm, CheckServerButton, InstallCommand, RemoveServer, UpdateServerButton } from "@/components/servers";
import { StatusChip, timeAgo } from "@/components/status";
import { agent } from "@/lib/agent";
import { boxConfig } from "@/lib/box";
import { listProjects } from "@/lib/projects";
import { requireUser } from "@/lib/session";
import { installCommand, listServers, type Server } from "@/lib/servers";

export const dynamic = "force-dynamic";
export const metadata = { title: "Servers" };

interface Release {
  url: string;
  sha256: string;
  installer: { url: string; sha256: string };
}

function status(s: Server): { dot: "ok" | "err" | "idle"; label: string } {
  if (s.error && (!s.seenAt || (s.checkedAt ?? 0) > s.seenAt)) return { dot: "err", label: "Unreachable" };
  if (s.seenAt) return { dot: "ok", label: "Connected" };
  return { dot: "idle", label: "Waiting for its install" };
}

export default async function ServersPage() {
  await requireUser();
  const box = boxConfig();
  const servers = listServers();
  const projects = listProjects();
  // This panel's own release, from its feed: what a new server installs.
  const release = await agent<{ release: Release | null }>("update.check").then((r) => r.release).catch(() => null);
  return (
    <>
      <PageHeader title="Servers" meta="Deploy to other servers from this panel. Each one keeps its own apps, databases and certificates." />
      <Section title="This server">
        <SettingsRow title={box.panelHost || "This server"} description="Where the panel runs. Projects go here unless you pick another server.">
          <KeyValues
            inset
            items={[
              ["Address", box.publicIp],
              ["Free addresses", `<app>.${box.appsDomain}`],
              ["Projects", String(projects.filter((p) => p.serverId === null).length)],
            ]}
          />
        </SettingsRow>
      </Section>
      {servers.map((s) => {
        const st = status(s);
        const count = projects.filter((p) => p.serverId === s.id).length;
        return (
          <Section key={s.id} title={s.name} aside={<StatusChip status={st.dot} label={st.label} />}>
            <SettingsRow
              title={
                <span className="flex items-center gap-2.5">
                  <TileIcon tone="blue" size="sm">
                    <Icon icon={ServerIcon} size={16} />
                  </TileIcon>
                  {s.host}
                </span>
              }
              description={s.seenAt ? `Last answered ${timeAgo(s.seenAt)}.` : "Run the command below on it as root, then check the connection."}
            >
              {s.info && (
                <KeyValues
                  inset
                  items={[
                    ["System", `${s.info.os.name} · ${s.info.arch} · ${s.info.cpus} CPU`],
                    ["Memory", `${Math.round(s.info.memoryMb.available / 102.4) / 10} of ${Math.round(s.info.memoryMb.total / 102.4) / 10} GB free`],
                    ["Disk", `${s.info.diskGb.free} of ${s.info.diskGb.total} GB free`],
                    ["Agent", s.info.agentVersion],
                    ["Free addresses", s.info.appsDomain ? `<app>.${s.info.appsDomain}` : "—"],
                    ["Projects", String(count)],
                  ]}
                />
              )}
              {s.error && st.dot === "err" && (
                <Notice lead="Unreachable" tone="err">
                  {s.error}
                </Notice>
              )}
              {!s.seenAt &&
                (release ? (
                  <InstallCommand command={installCommand(release)} />
                ) : (
                  <p className="text-[12px] text-muted">This panel&apos;s version isn&apos;t in its release feed, so there&apos;s no command to copy: install a release from the feed first.</p>
                ))}
              {s.info && s.info.version && s.info.version !== box.version && (
                <Notice lead="Another version">
                  It runs {s.info.version}; this panel runs {box.version}. The same version on both keeps every action the same.
                </Notice>
              )}
              <div className="flex flex-wrap items-start gap-2">
                {s.info && s.info.version && s.info.version !== box.version && <UpdateServerButton id={s.id} version={box.version} />}
                <CheckServerButton id={s.id} />
                <RemoveServer id={s.id} name={s.name} />
              </div>
            </SettingsRow>
          </Section>
        );
      })}
      <Section title="Add a server" description="A fresh Ubuntu 24.04 or 26.04, or Debian 12, VPS. The panel gets in only to its agent: a key locked to one command, never a shell or root.">
        <div className="px-3.5 pb-3.5">
          <AddServerForm />
        </div>
      </Section>
    </>
  );
}

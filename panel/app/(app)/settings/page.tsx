import { CheckmarkCircle02Icon, GithubIcon } from "@hugeicons/core-free-icons";
import { dropAddressAction } from "@/app/actions/address";
import { AccessForm } from "@/components/access";
import { MoveAppsForm, MovePanelForm } from "@/components/address";
import { Icon } from "@/components/icon";
import { KeyValues, PageHeader, PillLink, SettingsRow } from "@/components/page";
import { Button, Pill } from "@/components/ui";
import { agent, type SystemInfo } from "@/lib/agent";
import { boxConfig } from "@/lib/box";
import { GITHUB_WEB } from "@/lib/github";
import { getApp, listInstallations } from "@/lib/github-store";
import { requesterIp } from "@/lib/request";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function ServerSettingsPage() {
  const user = await requireUser();
  const box = boxConfig();
  const app = getApp();
  const installs = app ? listInstallations() : [];
  const info = await agent<SystemInfo>("system.info").catch(() => null);
  const you = await requesterIp();
  return (
    <>
      <PageHeader title="Settings" meta="This server and your account" />
      <SettingsRow
        title="Panel address"
        description="Where you open this panel. To move it, point a name you own at this server first: the panel checks public DNS, waits for the certificate, then the old address redirects."
      >
        <KeyValues
          inset
          items={[
            ["Panel", <code key="p" className="font-mono text-[13.5px]">{box.panelHost}</code>],
            ...(box.panelPending ?? []).map((h): [React.ReactNode, React.ReactNode] => ["Moving to", <AddressLine key={h} host={h} label="Stop" />]),
            ...(box.panelAliases ?? []).map((h): [React.ReactNode, React.ReactNode] => ["Redirects here", <AddressLine key={h} host={h} label="Remove" />]),
            ["Public IP", <code key="i" className="font-mono text-[13.5px]">{box.publicIp}</code>],
          ]}
        />
        <MovePanelForm />
      </SettingsRow>
      <SettingsRow title="Apps domain" description="Every app gets a free URL under it. Your own domain needs one wildcard record; the old URLs keep redirecting.">
        <KeyValues inset items={[["Free URLs", <code key="a" className="font-mono text-[13.5px]">&lt;app&gt;.{box.appsDomain}</code>]]} />
        <MoveAppsForm current={box.appsDomain} />
      </SettingsRow>
      <SettingsRow title="Access" description="Who can reach the panel at all. Blocked requests stop at Caddy and never reach the panel; locked out, run layer access reset on the server.">
        <AccessForm allow={box.panelAllow ?? []} you={you} />
      </SettingsRow>
      <SettingsRow title="GitHub" description="A private GitHub App owned by you. Its key never leaves this server.">
        {app ? (
          <>
            <KeyValues
              inset
              items={[
                [
                  "App",
                  <span key="a" className="inline-flex items-center gap-1.5">
                    {app.name} <Icon icon={CheckmarkCircle02Icon} size={14} className="text-teal" />
                  </span>,
                ],
                ["Owner", app.ownerLogin],
                ["Installed on", installs.length ? installs.map((i) => i.accountLogin).join(", ") : "No accounts yet"],
              ]}
            />
            <div className="flex flex-wrap gap-2">
              <PillLink href={app.htmlUrl} external size="sm">
                <Icon icon={GithubIcon} size={14} /> Manage on GitHub
              </PillLink>
              <PillLink href={`${GITHUB_WEB}/apps/${app.slug}/installations/new`} external size="sm">
                Install on more repositories
              </PillLink>
            </div>
          </>
        ) : (
          <div>
            <PillLink href="/github/connect" primary size="sm">
              <Icon icon={GithubIcon} size={14} /> Connect GitHub
            </PillLink>
          </div>
        )}
      </SettingsRow>
      <SettingsRow title="Account" description="Signing in always takes your password and a code from your authenticator app.">
        <KeyValues
          inset
          items={[
            ["Email", user.email],
            ["Two-factor", <Pill key="t" className="bg-teal/18 text-teal">On</Pill>],
          ]}
        />
      </SettingsRow>
      <SettingsRow title="Version" description="Updating the panel never restarts your apps.">
        <KeyValues
          inset
          items={[
            ["Panel", <code key="v" className="font-mono text-[13.5px]">{box.version}</code>],
            ["Agent", <code key="g" className="font-mono text-[13.5px]">{info?.agentVersion ?? "—"}</code>],
            ["Server", info ? `${info.os.name} · ${info.arch} · Node ${info.nodeVersions.join(", ")}` : "—"],
          ]}
        />
      </SettingsRow>
      <SettingsRow title="Remove the panel" description="Your apps keep running: they're plain systemd units and Caddy sites. Only the panel goes.">
        <p className="text-[13.5px] text-muted">
          On the server, run <code className="rounded bg-hover px-1.5 py-0.5 font-mono text-[12.5px] text-foreground">sudo systemctl disable --now layer-panel layer-agent</code>. The README lists everything the installer created, if you want it all gone.
        </p>
      </SettingsRow>
    </>
  );
}

/** An address the panel answers on besides its own, with a button to drop it. */
function AddressLine({ host, label }: { host: string; label: string }) {
  return (
    <span className="flex items-center justify-between gap-3">
      <code className="min-w-0 truncate font-mono text-[13.5px]">{host}</code>
      <form action={dropAddressAction}>
        <input type="hidden" name="host" value={host} />
        <Button type="submit" variant="ghost" size="sm">
          {label}
        </Button>
      </form>
    </span>
  );
}

import { CheckmarkCircle02Icon, GithubIcon } from "@hugeicons/core-free-icons";
import { dropAddressAction } from "@/app/actions/address";
import { signOutOthersAction } from "@/app/actions/account";
import { AccessForm } from "@/components/access";
import { BuildSlotsForm } from "@/components/builds";
import { ChangePasswordForm, RecoveryCodesForm } from "@/components/account";
import { MoveAppsForm, MovePanelForm } from "@/components/address";
import { RepairButton, UpdatePanel } from "@/components/maintenance";
import { Icon } from "@/components/icon";
import { KeyValues, PageHeader, PillLink, SettingsRow } from "@/components/page";
import { Button, Pill } from "@/components/ui";
import { agent, type SystemInfo } from "@/lib/agent";
import { boxConfig } from "@/lib/box";
import { buildSlots } from "@/lib/deploy";
import { GITHUB_WEB } from "@/lib/github";
import { getApp, listInstallations } from "@/lib/github-store";
import { db } from "@/lib/db";
import { requesterIp } from "@/lib/request";
import { PANEL_MOVE, readState } from "@/lib/panel-state";
import { listSessions, requireUser } from "@/lib/session";
import { timeAgo } from "@/components/status";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function ServerSettingsPage() {
  const user = await requireUser();
  const box = boxConfig();
  const app = getApp();
  const installs = app ? listInstallations() : [];
  const info = await agent<SystemInfo>("system.info").catch(() => null);
  const you = await requesterIp();
  const sessions = await listSessions(user.id);
  const codesLeft = (db().prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL").get(user.id) as { n: number }).n;
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
        <MovePanelForm waiting={readState(PANEL_MOVE)} ip={box.publicIp} />
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
      <SettingsRow
        title="Builds"
        description={`How many projects can build at the same time. Others wait in line and start as soon as one finishes. A build can use twice its app's memory limit (at least 1 GB)${info ? `, and this server has ${(info.memoryMb.total / 1024).toFixed(1)} GB of memory${info.swapMb.total ? ` and ${(info.swapMb.total / 1024).toFixed(1)} GB of swap` : ""}` : ""}: on small servers, one at a time is safest.`}
      >
        <BuildSlotsForm current={buildSlots()} />
      </SettingsRow>
      <SettingsRow title="Account" description="Signing in always takes your password and a code from your authenticator app.">
        <KeyValues
          inset
          items={[
            ["Email", user.email],
            ["Two-factor", <Pill key="t" className="bg-teal/18 text-teal">On</Pill>],
            ["Recovery codes", `${codesLeft} unused`],
          ]}
        />
        <div className="grid gap-2" data-testid="sessions">
          <p className="text-[13px] font-medium">Signed in</p>
          {sessions.map((s, i) => (
            <div key={i} className="flex items-center justify-between gap-3 text-[13.5px]">
              <span className="min-w-0 truncate">
                {browserName(s.userAgent)}
                <span className="text-muted"> · {s.ip ?? "unknown address"} · {timeAgo(s.createdAt)}</span>
              </span>
              {s.current && <Pill outline>This browser</Pill>}
            </div>
          ))}
          {sessions.length > 1 && (
            <form action={signOutOthersAction}>
              <Button type="submit" variant="ghost" size="sm" className="-ml-3">
                Sign out the others
              </Button>
            </form>
          )}
        </div>
        <ChangePasswordForm />
        <RecoveryCodesForm />
      </SettingsRow>
      <SettingsRow title="Version" description="Updating the panel never restarts your apps. On the server, layer update does the same.">
        <KeyValues
          inset
          items={[
            ["Panel", <code key="v" className="font-mono text-[13.5px]">{box.version}</code>],
            ["Agent", <code key="g" className="font-mono text-[13.5px]">{info?.agentVersion ?? "—"}</code>],
            ["Server", info ? `${info.os.name} · ${info.arch} · Node ${info.nodeVersions.join(", ")}` : "—"],
          ]}
        />
        <UpdatePanel current={box.version} />
      </SettingsRow>
      <SettingsRow title="Repair" description="Puts back unit files, Caddy sites and env files someone edited or deleted by hand, and restarts what they feed. layer repair on the server does the same.">
        <RepairButton />
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

/** "Chrome on macOS" from a user agent; good enough to tell sessions apart. */
function browserName(ua: string | null): string {
  if (!ua) return "Unknown browser";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl\//.test(ua) ? "curl" : "A browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : null;
  return os ? `${browser} on ${os}` : browser;
}

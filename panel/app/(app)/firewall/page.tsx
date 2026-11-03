import { ShieldIcon } from "lucide-react";
import { ComingSoon, Empty, Notice, PageHeader, Section, Segmented, TableHead, TableRow } from "@/components/page";
import { Icon } from "@/components/icon";
import { StatusText } from "@/components/status";
import { agent } from "@/lib/agent";
import { listServers } from "@/lib/servers";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Firewall" };

interface FirewallStatus {
  ufw: { installed: boolean; enabled: boolean; rules: { action: string; protocol: string; port: string; from: string; ipv6: boolean; comment: string | null }[] };
  fail2ban: { running: boolean; jails: { name: string; currentlyFailed: number; totalBanned: number; currentlyBanned: number; banned: string[] }[] };
}

const SERVICE: Record<string, string> = { "22": "SSH", "80": "HTTP → HTTPS (Caddy)", "443": "HTTPS: apps and this panel (Caddy)" };

export default async function FirewallPage({ searchParams }: { searchParams: Promise<{ server?: string }> }) {
  await requireUser();
  // This server's, or another one's (?server=).
  const asked = (await searchParams).server;
  const servers = listServers().filter((s) => s.seenAt);
  const serverId = servers.find((s) => String(s.id) === asked)?.id ?? null;
  const status = await agent<FirewallStatus>("firewall.status", {}, { server: serverId }).catch(() => null);
  // The same rule for IPv4 and IPv6 is one row.
  const rules = new Map<string, FirewallStatus["ufw"]["rules"][number] & { both: boolean }>();
  for (const r of status?.ufw.rules ?? []) {
    const key = `${r.action}|${r.protocol}|${r.port}|${r.from}|${r.comment}`;
    const seen = rules.get(key);
    if (seen) seen.both = true;
    else rules.set(key, { ...r, both: false });
  }
  const bans = (status?.fail2ban.jails ?? []).flatMap((j) => j.banned.map((ip) => ({ ip, jail: j.name })));
  const columns = "90px 80px minmax(160px,1fr) 150px 100px";
  return (
    <>
      <PageHeader title="Firewall" meta={status ? `ufw ${status.ufw.enabled ? "active" : "off"} · fail2ban ${status.fail2ban.running ? "running" : "not running"}` : undefined} />
      {servers.length > 0 && <Segmented items={[{ href: "/firewall", label: "This server", active: serverId === null }, ...servers.map((s) => ({ href: `/firewall?server=${s.id}`, label: s.name, active: serverId === s.id }))]} />}
      {!status ? (
        <Notice lead="Unavailable" tone="err">
          Couldn&apos;t ask the agent about the firewall.
        </Notice>
      ) : status.ufw.enabled ? (
        <Notice lead="Protected" tone="ok">
          Only {[...new Set([...rules.values()].filter((r) => r.action === "allow").map((r) => r.port))].join(", ")} are open. Apps, Redis and Postgres listen on 127.0.0.1 only.
          {bans.length > 0 && ` ${bans.length} IP${bans.length === 1 ? " is" : "s are"} banned right now.`}
        </Notice>
      ) : (
        <Notice lead="Firewall off" tone="err">
          ufw isn&apos;t enabled, so every listening port is reachable. Re-run the installer to turn it on.
        </Notice>
      )}
      {status && (
        <Section title="Rules" description="What's reachable from the internet (ufw).">
          <TableHead columns={columns}>
            <span>Port</span>
            <span>Protocol</span>
            <span>Service</span>
            <span>From</span>
            <span className="text-right">Action</span>
          </TableHead>
          {rules.size === 0 && <Empty>No rules.</Empty>}
          {[...rules.values()].map((r, i) => (
            <TableRow key={i} columns={columns}>
              <code className="font-mono text-sm">{r.port}</code>
              <span className="uppercase text-muted max-md:hidden">{r.protocol}</span>
              <span className="min-w-0 flex-1 truncate">{SERVICE[r.port] ?? r.comment ?? "—"}</span>
              <span className="text-muted max-md:hidden">
                {r.from}
                {r.both ? " (IPv4 + IPv6)" : r.ipv6 ? " (IPv6)" : ""}
              </span>
              <span className="justify-self-end max-md:ml-auto">{r.action === "allow" ? <StatusText status="ok" label="Allow" /> : <StatusText status="err" label={r.action === "limit" ? "Limit" : "Deny"} />}</span>
            </TableRow>
          ))}
        </Section>
      )}
      {status && (
        <Section title="Banned IPs" description="Blocked by fail2ban after repeated failed logins. Bans expire on their own.">
          <TableHead columns="minmax(160px,1fr) 160px">
            <span>IP</span>
            <span>Jail</span>
          </TableHead>
          {bans.length === 0 && <Empty>{status.fail2ban.running ? "Nobody is banned right now." : "fail2ban isn't running."}</Empty>}
          {bans.map((b) => (
            <TableRow key={`${b.jail}/${b.ip}`} columns="minmax(160px,1fr) 160px">
              <code className="font-mono text-[13.5px]">{b.ip}</code>
              <span className="text-muted">{b.jail}</span>
            </TableRow>
          ))}
        </Section>
      )}
      <ComingSoon icon={<Icon icon={ShieldIcon} size={20} />} title="Change rules from here">
        Open or close ports, unban IPs, rate-limit an app, and restrict this panel to your IP or Tailscale.
      </ComingSoon>
    </>
  );
}

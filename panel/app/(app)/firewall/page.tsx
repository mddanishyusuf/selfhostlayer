import { Shield } from "lucide-react";
import { ComingSoon, PageBody, PageHeader, RowList, Section } from "@/components/page";
import { StatusDot } from "@/components/ui";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Firewall" };

const OPEN = [
  ["22", "SSH", "Your terminal access (keys only once you turn off passwords)."],
  ["80", "HTTP", "Caddy, only to redirect to HTTPS and answer certificate checks."],
  ["443", "HTTPS", "Caddy: every app, domain and this panel."],
];

export default async function FirewallPage() {
  await requireUser();
  return (
    <>
      <PageHeader title="Firewall" />
      <PageBody>
        <Section title="Open to the internet" description="Set up by the installer (ufw). Everything else is closed: apps, Redis and Postgres only listen on 127.0.0.1.">
          <RowList>
            {OPEN.map(([port, name, what]) => (
              <div key={port} className="flex items-center gap-4 px-4 py-3.5 sm:px-5">
                <StatusDot status="ok" />
                <p className="w-14 shrink-0 font-mono text-[15px] font-bold tabular-nums">{port}</p>
                <div className="grid min-w-0 gap-0.5">
                  <p className="text-[15px] font-bold">{name}</p>
                  <p className="text-[13px] text-muted">{what}</p>
                </div>
              </div>
            ))}
          </RowList>
        </Section>
        <ComingSoon icon={<Shield className="size-5" aria-hidden />} title="Rules, blocked IPs and rate limits">
          See and change firewall rules here, block IPs and countries, rate-limit an app, restrict the panel to your IP or Tailscale, and see what fail2ban has banned.
        </ComingSoon>
      </PageBody>
    </>
  );
}

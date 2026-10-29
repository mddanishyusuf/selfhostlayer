"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { agent } from "@/lib/agent";
import { moveFreeUrls } from "@/lib/apps-domain";
import { pinBackupFolder } from "@/lib/backup/runner";
import { boxConfig } from "@/lib/box";
import { checkCertificate } from "@/lib/cert";
import { checkDomain } from "@/lib/dns";
import { normalizeHost } from "@/lib/domains";
import { setWebhookUrl } from "@/lib/github";
import { getApp } from "@/lib/github-store";
import { requireUser } from "@/lib/session";

export interface AddressState {
  error?: string;
  /** The DNS record to create first. */
  record?: { type: string; name: string; value: string };
  /** Added, but its certificate isn't ready: the panel answers on both. */
  pending?: string;
  /** Moved: open the panel here. */
  done?: string;
  warning?: string;
}

// Test boxes run on Caddy's local CA and use names (.internal) no public resolver knows.
const testBox = () => boxConfig().internalTls === true;

async function certificateReady(host: string, internalTls: boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const cert = await checkCertificate(host);
    if (cert.ok || (internalTls && cert.reason === "untrusted")) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/**
 * Moves the panel to a new address in two steps, so a certificate that won't
 * issue can't lock anyone out: answer on both, wait for the new certificate,
 * then make the old address redirect.
 */
export async function movePanelAction(_prev: AddressState, form: FormData): Promise<AddressState> {
  await requireUser();
  const host = normalizeHost(String(form.get("host") ?? ""));
  if (!host) return { error: "Enter a name like panel.example.com." };
  const box = boxConfig();
  if (host === box.panelHost) return { error: "That's already the panel's address." };
  if (!testBox()) {
    const { verdict, message } = await checkDomain(host, box.publicIp);
    if (verdict.status !== "ok") return { error: message, record: { type: "A", name: host, value: box.publicIp } };
  }
  const aliases = (box.panelAliases ?? []).filter((h) => h !== host);
  await agent("panel.address", { hosts: [box.panelHost, host], redirects: aliases });
  if (!(await certificateReady(host, box.internalTls === true, 90_000))) {
    revalidatePath("/settings");
    return { pending: host };
  }
  pinBackupFolder();
  await agent("panel.address", { hosts: [host], redirects: [box.panelHost, ...aliases] });
  let warning: string | undefined;
  const app = getApp();
  if (app) {
    await setWebhookUrl(app.credentials, `https://${host}/api/github/webhook`).catch(() => {
      warning = `Change the webhook URL in your GitHub App's settings to https://${host}/api/github/webhook: pushes won't deploy until then.`;
    });
  }
  revalidatePath("/settings");
  return { done: `https://${host}`, warning };
}

/** Stops answering on a pending address, or stops redirecting an old one. */
export async function dropAddressAction(form: FormData): Promise<void> {
  await requireUser();
  const host = String(form.get("host") ?? "");
  const box = boxConfig();
  await agent("panel.address", {
    hosts: [box.panelHost, ...(box.panelPending ?? []).filter((h) => h !== host)],
    redirects: (box.panelAliases ?? []).filter((h) => h !== host),
  });
  revalidatePath("/settings");
}

export interface AppsDomainState {
  error?: string;
  record?: { type: string; name: string; value: string };
  done?: string;
  moved?: number;
  failed?: string[];
}

/** Moves every app's free URL to <slug>.<domain>, once a wildcard record sends them all here. */
export async function moveAppsDomainAction(_prev: AppsDomainState, form: FormData): Promise<AppsDomainState> {
  await requireUser();
  const raw = String(form.get("domain") ?? "").trim().toLowerCase().replace(/^\*\./, "");
  const domain = raw === "internal" ? raw : normalizeHost(raw);
  if (!domain) return { error: "Enter a domain like apps.example.com." };
  const box = boxConfig();
  if (domain === box.appsDomain) return { error: "Apps already use that domain." };
  if (domain === box.panelHost) return { error: "That's the panel's address: use a name under it, like apps.example.com." };
  if (!testBox()) {
    // Any name under it must come here: check one nobody uses.
    const { verdict } = await checkDomain(`layer-check-${randomBytes(4).toString("hex")}.${domain}`, box.publicIp);
    if (verdict.status !== "ok") {
      return { error: `*.${domain} doesn't point at this server yet. Add the record below; it can take a few minutes to spread.`, record: { type: "A", name: `*.${domain}`, value: box.publicIp } };
    }
  }
  await agent("apps.domain", { domain });
  const { moved, failed } = await moveFreeUrls(box.appsDomain, domain);
  revalidatePath("/settings");
  revalidatePath("/domains");
  return { done: domain, moved, failed };
}

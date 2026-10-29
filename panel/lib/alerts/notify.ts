// Sending alerts: Telegram, Discord, a generic (optionally signed) webhook, and email.
import { createHmac } from "node:crypto";
import { sendMail, type SmtpConfig } from "./smtp";

export type ChannelConfig =
  | { kind: "telegram"; botToken: string; chatId: string }
  | { kind: "discord"; webhookUrl: string }
  | { kind: "webhook"; url: string; secret?: string }
  | ({ kind: "email" } & SmtpConfig);

export interface AlertMessage {
  event: "opened" | "resolved" | "test";
  key: string;
  title: string;
  detail: string;
  link: string | null;
  at: string;
}

/** The text people read (Telegram, Discord). */
export function formatText(m: AlertMessage, server: string): string {
  const icon = m.event === "opened" ? "🔴" : m.event === "resolved" ? "✅" : "🔔";
  const head = m.event === "resolved" ? `Resolved: ${m.title}` : m.title;
  return [`${icon} ${head}`, m.detail, m.link ?? "", `— ${server}`].filter(Boolean).join("\n").slice(0, 1900);
}

type Fetch = typeof fetch;

async function post(fetchImpl: Fetch, url: string, body: unknown, headers: Record<string, string> = {}): Promise<void> {
  const payload = JSON.stringify(body);
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "self-host-layer", ...headers },
    body: payload,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

export async function send(config: ChannelConfig, m: AlertMessage, server: string, fetchImpl: Fetch = fetch, mailer: typeof sendMail = sendMail): Promise<void> {
  switch (config.kind) {
    case "email": {
      const subject = m.event === "resolved" ? `Resolved: ${m.title}` : m.event === "test" ? m.title : `Alert: ${m.title}`;
      return mailer(config, { subject: `${subject} (${server})`, text: formatText(m, server).replace(/^[🔴✅🔔] /u, "") });
    }
    case "telegram":
      return post(fetchImpl, `https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        chat_id: config.chatId,
        text: formatText(m, server),
        disable_web_page_preview: true,
      });
    case "discord":
      return post(fetchImpl, config.webhookUrl, { content: formatText(m, server), allowed_mentions: { parse: [] } });
    case "webhook": {
      const body = { ...m, server };
      const headers: Record<string, string> = {};
      // Receivers can check X-Layer-Signature: sha256=HMAC(secret, raw body), like GitHub's.
      if (config.secret) headers["X-Layer-Signature"] = `sha256=${createHmac("sha256", config.secret).update(JSON.stringify(body)).digest("hex")}`;
      return post(fetchImpl, config.url, body, headers);
    }
  }
}

const TELEGRAM_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
const CHAT_ID = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const EMAIL = /^[^\s@<>",;]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$/i;
const DISCORD_WEBHOOK = /^https:\/\/(?:discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;

/** Validates what the user typed for a channel. */
export function parseChannel(kind: string, form: Record<string, string>): { ok: true; config: ChannelConfig } | { ok: false; error: string } {
  if (kind === "telegram") {
    const botToken = form.botToken?.trim() ?? "";
    const chatId = form.chatId?.trim() ?? "";
    if (!TELEGRAM_TOKEN.test(botToken)) return { ok: false, error: "That doesn't look like a bot token from @BotFather (123456789:AA…)." };
    if (!CHAT_ID.test(chatId)) return { ok: false, error: "The chat ID is a number (e.g. 123456789 or -1001234567890) or @channelname." };
    return { ok: true, config: { kind, botToken, chatId } };
  }
  if (kind === "discord") {
    const webhookUrl = form.webhookUrl?.trim() ?? "";
    if (!DISCORD_WEBHOOK.test(webhookUrl)) return { ok: false, error: "Paste the webhook URL from Discord (https://discord.com/api/webhooks/…)." };
    return { ok: true, config: { kind, webhookUrl } };
  }
  if (kind === "webhook") {
    const url = form.url?.trim() ?? "";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: "Enter a full URL starting with https://." };
    }
    if (parsed.protocol !== "https:") return { ok: false, error: "The webhook URL must use https://." };
    const secret = form.secret?.trim() || undefined;
    return { ok: true, config: { kind, url, ...(secret ? { secret } : {}) } };
  }
  if (kind === "email") {
    const host = form.host?.trim().toLowerCase() ?? "";
    const port = Number(form.port?.trim() || 587);
    const security = (form.security?.trim() || "starttls") as SmtpConfig["security"];
    const from = form.from?.trim() ?? "";
    const to = (form.to ?? "").split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
    const local = host === "127.0.0.1" || host === "localhost";
    if (!/^[a-z0-9.-]{1,253}$/.test(host) || !host.includes(".") && !local) return { ok: false, error: "Enter the SMTP server's host name (e.g. smtp.resend.com)." };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "The port is a number, usually 587 or 465." };
    if (!["tls", "starttls", "none"].includes(security)) return { ok: false, error: "Pick how to connect." };
    if (security === "none" && !local) return { ok: false, error: "Unencrypted SMTP is only allowed to a relay on this server." };
    if (!EMAIL.test(from)) return { ok: false, error: "The From address must be an email address your mail service lets you send from." };
    if (to.length === 0 || to.length > 5 || !to.every((t) => EMAIL.test(t))) return { ok: false, error: "Send to 1–5 email addresses, separated by commas." };
    const user = form.user?.trim() || undefined;
    const pass = form.pass ?? undefined;
    if (user && /[\r\n\0]/.test(user + (pass ?? ""))) return { ok: false, error: "The username or password has invalid characters." };
    return { ok: true, config: { kind, host, port, security, from, to, ...(user ? { user, pass: pass ?? "" } : {}) } };
  }
  return { ok: false, error: "Pick Telegram, Discord, Webhook or Email." };
}

// Sending alerts: Telegram, Discord and a generic (optionally signed) webhook.
import { createHmac } from "node:crypto";

export type ChannelConfig =
  | { kind: "telegram"; botToken: string; chatId: string }
  | { kind: "discord"; webhookUrl: string }
  | { kind: "webhook"; url: string; secret?: string };

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

export async function send(config: ChannelConfig, m: AlertMessage, server: string, fetchImpl: Fetch = fetch): Promise<void> {
  switch (config.kind) {
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
  return { ok: false, error: "Pick Telegram, Discord or Webhook." };
}

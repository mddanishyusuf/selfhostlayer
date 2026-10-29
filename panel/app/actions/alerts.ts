"use server";

import { revalidatePath } from "next/cache";
import { addChannel, configureAlerts, listChannels, notifyAll, removeChannel } from "@/lib/alerts/engine";
import { parseChannel } from "@/lib/alerts/notify";
import { boxConfig } from "@/lib/box";
import { requireUser } from "@/lib/session";

try {
  configureAlerts({ serverName: boxConfig().panelHost });
} catch {
  // no box config (dev)
}

export interface ChannelState {
  error?: string;
  ok?: string;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

export async function addChannelAction(_prev: ChannelState, form: FormData): Promise<ChannelState> {
  await requireUser();
  const kind = field(form, "kind");
  const parsed = parseChannel(kind, { botToken: field(form, "botToken"), chatId: field(form, "chatId"), webhookUrl: field(form, "webhookUrl"), url: field(form, "url"), secret: field(form, "secret") });
  if (!parsed.ok) return { error: parsed.error };
  const name = field(form, "name") || { telegram: "Telegram", discord: "Discord", webhook: "Webhook" }[parsed.config.kind];
  const id = addChannel(name.slice(0, 60), parsed.config);
  // Prove it works right away: a test message to just this channel.
  const channel = listChannels().find((c) => c.id === id)!;
  const errors = await notifyAll({ event: "test", key: "test", title: "Alerts from Self Host Layer are set up", detail: "You'll get one message when something breaks, and one when it recovers.", link: null, at: new Date().toISOString() }, [channel]);
  revalidatePath("/settings/alerts");
  return errors.length ? { error: `Saved, but the test message failed: ${errors[0]}` } : { ok: `Saved ${name}. A test message is on its way.` };
}

export async function testChannelAction(form: FormData): Promise<void> {
  await requireUser();
  const channel = listChannels().find((c) => c.id === Number(field(form, "id")));
  if (!channel) return;
  await notifyAll({ event: "test", key: "test", title: "Test alert from Self Host Layer", detail: "This channel works.", link: null, at: new Date().toISOString() }, [channel]);
  revalidatePath("/settings/alerts");
}

export async function removeChannelAction(form: FormData): Promise<void> {
  await requireUser();
  removeChannel(Number(field(form, "id")));
  revalidatePath("/settings/alerts");
}

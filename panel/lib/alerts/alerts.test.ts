import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { formatText, parseChannel, send, type AlertMessage } from "./notify";

const message: AlertMessage = { event: "opened", key: "deploy:1", title: "Deploy failed: piqo", detail: "the build failed (exit 1)", link: "https://panel.example/deployments/9", at: "2026-10-29T09:00:00.000Z" };

function capture() {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
    return new Response("ok");
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("notifications", () => {
  it("formats opened, resolved and test messages", () => {
    expect(formatText(message, "cx23")).toBe("🔴 Deploy failed: piqo\nthe build failed (exit 1)\nhttps://panel.example/deployments/9\n— cx23");
    expect(formatText({ ...message, event: "resolved", detail: "" }, "cx23")).toMatch(/^✅ Resolved: Deploy failed: piqo\n/);
  });

  it("sends to Telegram's sendMessage with the chat id", async () => {
    const { calls, fetchImpl } = capture();
    await send({ kind: "telegram", botToken: "123456789:AAH_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", chatId: "-100123" }, message, "cx23", fetchImpl);
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot123456789:AAH_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/sendMessage");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ chat_id: "-100123", text: expect.stringContaining("Deploy failed: piqo") });
  });

  it("posts Discord content with mentions disabled", async () => {
    const { calls, fetchImpl } = capture();
    await send({ kind: "discord", webhookUrl: "https://discord.com/api/webhooks/1/abc" }, message, "cx23", fetchImpl);
    expect(JSON.parse(calls[0]!.body)).toEqual({ content: expect.stringContaining("🔴"), allowed_mentions: { parse: [] } });
  });

  it("signs webhook bodies so receivers can verify them", async () => {
    const { calls, fetchImpl } = capture();
    await send({ kind: "webhook", url: "https://hooks.example/layer", secret: "s3cret" }, message, "cx23", fetchImpl);
    const { body, headers } = calls[0]!;
    expect(JSON.parse(body)).toMatchObject({ event: "opened", key: "deploy:1", server: "cx23" });
    expect(headers["X-Layer-Signature"]).toBe(`sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`);
  });

  it("reports a failing channel as an error", async () => {
    const failing = (async () => new Response("bad token", { status: 401 })) as unknown as typeof fetch;
    await expect(send({ kind: "discord", webhookUrl: "https://discord.com/api/webhooks/1/x" }, message, "s", failing)).rejects.toThrow(/401/);
  });

  it("validates channel settings", () => {
    expect(parseChannel("telegram", { botToken: "123456789:AAH_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", chatId: "123" }).ok).toBe(true);
    expect(parseChannel("telegram", { botToken: "nope", chatId: "123" })).toMatchObject({ ok: false, error: expect.stringContaining("BotFather") });
    expect(parseChannel("discord", { webhookUrl: "https://evil.example/api/webhooks/1/x" }).ok).toBe(false);
    expect(parseChannel("webhook", { url: "http://insecure.example" })).toMatchObject({ ok: false, error: expect.stringContaining("https") });
    expect(parseChannel("sms", {}).ok).toBe(false);
  });
});

describe("incident engine", () => {
  let engine: typeof import("./engine");
  const sent: { channel: string; event: string; title: string }[] = [];

  beforeAll(async () => {
    process.env.LAYER_DEV_DIR = mkdtempSync(join(tmpdir(), "layer-alerts-"));
    engine = await import("./engine");
    engine.configureAlerts({
      serverName: "test",
      sender: async (channel, m) => {
        if (channel.name === "broken") throw new Error("HTTP 500");
        sent.push({ channel: channel.name, event: m.event, title: m.title });
      },
    });
    engine.addChannel("ops", { kind: "discord", webhookUrl: "https://discord.com/api/webhooks/1/x" });
  });

  it("notifies once per incident, however often the problem is seen", async () => {
    expect(await engine.raise("disk", { title: "Disk 85% full" })).toBe(true);
    expect(await engine.raise("disk", { title: "Disk 86% full" })).toBe(false);
    expect(sent.filter((s) => s.title.startsWith("Disk"))).toEqual([{ channel: "ops", event: "opened", title: "Disk 85% full" }]);
  });

  it("sends one recovery message and allows a new incident afterwards", async () => {
    expect(await engine.resolve("disk")).toBe(true);
    expect(await engine.resolve("disk")).toBe(false);
    expect(sent.at(-1)).toEqual({ channel: "ops", event: "resolved", title: "Disk 85% full" });
    expect(await engine.raise("disk", { title: "Disk 90% full" })).toBe(true);
    expect(engine.listIncidents().filter((i) => i.key === "disk")).toHaveLength(2);
  });

  it("keeps delivery failures on the incident instead of throwing", async () => {
    const id = engine.addChannel("broken", { kind: "webhook", url: "https://x.example" });
    await engine.raise("cron:piqo:sync", { title: "Cron failed: piqo/sync" });
    expect(engine.openIncident("cron:piqo:sync")!.notifyErrors).toBe("broken: HTTP 500");
    engine.removeChannel(id);
  });

  it("stores channel secrets encrypted", async () => {
    const { db } = await import("../db");
    const raw = db().prepare("SELECT config_enc FROM alert_channels").all() as { config_enc: string }[];
    expect(raw.every((r) => r.config_enc.startsWith("v1.") && !r.config_enc.includes("discord.com"))).toBe(true);
  });
});

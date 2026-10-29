"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { addChannelAction, type ChannelState } from "@/app/actions/alerts";
import { SubmitButton } from "./form";
import { Field, FormError, Input, cx } from "./ui";

const KINDS = [
  ["telegram", "Telegram"],
  ["discord", "Discord"],
  ["webhook", "Webhook"],
] as const;

export function AddChannelForm() {
  const [state, action] = useActionState(addChannelAction, {} as ChannelState);
  const [kind, setKind] = useState<(typeof KINDS)[number][0]>("telegram");
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) form.current?.reset();
  }, [state]);
  return (
    <form ref={form} action={action} className="grid gap-4">
      <input type="hidden" name="kind" value={kind} />
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Channel type">
        {KINDS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={kind === value}
            onClick={() => setKind(value)}
            className={cx("rounded-md border px-3 py-2 text-[13px] font-medium transition-colors duration-150", kind === value ? "border-foreground" : "border-border text-muted hover:bg-hover")}
          >
            {label}
          </button>
        ))}
      </div>
      {kind === "telegram" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bot token" htmlFor="botToken" hint="From @BotFather → /newbot.">
            <Input id="botToken" name="botToken" autoComplete="off" spellCheck={false} placeholder="123456789:AA…" className="font-mono text-[13px]" />
          </Field>
          <Field label="Chat ID" htmlFor="chatId" hint="Message your bot, then open api.telegram.org/bot<token>/getUpdates.">
            <Input id="chatId" name="chatId" autoComplete="off" spellCheck={false} placeholder="123456789" className="font-mono text-[13px]" />
          </Field>
        </div>
      )}
      {kind === "discord" && (
        <Field label="Webhook URL" htmlFor="webhookUrl" hint="Channel settings → Integrations → Webhooks → Copy URL.">
          <Input id="webhookUrl" name="webhookUrl" autoComplete="off" spellCheck={false} placeholder="https://discord.com/api/webhooks/…" className="font-mono text-[13px]" />
        </Field>
      )}
      {kind === "webhook" && (
        <div className="grid gap-4 sm:grid-cols-[1.6fr_1fr]">
          <Field label="URL" htmlFor="url" hint="Receives a JSON POST for every alert.">
            <Input id="url" name="url" autoComplete="off" spellCheck={false} placeholder="https://example.com/hooks/layer" className="font-mono text-[13px]" />
          </Field>
          <Field label="Secret (optional)" htmlFor="secret" hint="Signs X-Layer-Signature (HMAC-SHA256).">
            <Input id="secret" name="secret" type="password" autoComplete="off" />
          </Field>
        </div>
      )}
      <Field label="Name (optional)" htmlFor="channelName">
        <Input id="channelName" name="name" placeholder={KINDS.find(([v]) => v === kind)![1]} autoComplete="off" />
      </Field>
      <FormError message={state.error} />
      {state.ok && <p className="text-[13px] text-ok">{state.ok}</p>}
      <SubmitButton pending="Saving and sending a test…" className="w-auto justify-self-end px-4">
        Save and send a test
      </SubmitButton>
    </form>
  );
}

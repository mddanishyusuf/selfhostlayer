"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { addChannelAction, type ChannelState } from "@/app/actions/alerts";
import { SubmitButton } from "./form";
import { Field, FormError, Input, SecretInput, cx } from "./ui";

const KINDS = [
  ["telegram", "Telegram"],
  ["discord", "Discord"],
  ["webhook", "Webhook"],
  ["email", "Email"],
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
      <div className="inline-flex flex-wrap gap-0.5 justify-self-start rounded-lg border border-border-strong p-[3px]" role="radiogroup" aria-label="Channel type">
        {KINDS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={kind === value}
            onClick={() => setKind(value)}
            className={cx("h-7 rounded-md px-3 text-[13px] font-medium transition-colors duration-150", kind === value ? "bg-selected text-foreground" : "text-muted hover:text-foreground")}
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
            <SecretInput id="secret" name="secret" className="font-mono text-[13px]" />
          </Field>
        </div>
      )}
      {kind === "email" && (
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-[1.6fr_0.6fr_1fr]">
            <Field label="SMTP server" htmlFor="host">
              <Input id="host" name="host" autoComplete="off" spellCheck={false} placeholder="smtp.resend.com" className="font-mono text-[13px]" />
            </Field>
            <Field label="Port" htmlFor="port">
              <Input id="port" name="port" inputMode="numeric" defaultValue="587" className="font-mono text-[13px]" />
            </Field>
            <Field label="Security" htmlFor="security">
              <select id="security" name="security" defaultValue="starttls" className="h-10 rounded-[10px] border border-border-strong bg-field px-2 text-sm">
                <option value="starttls">STARTTLS (587)</option>
                <option value="tls">TLS (465)</option>
              </select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Username" htmlFor="user">
              <Input id="user" name="user" autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Password" htmlFor="pass" hint="An API key or app password, not your account password.">
              <SecretInput id="pass" name="pass" className="font-mono text-[13px]" />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From" htmlFor="from" hint="An address your mail service lets you send from.">
              <Input id="from" name="from" type="email" autoComplete="off" placeholder="alerts@example.com" />
            </Field>
            <Field label="To" htmlFor="to" hint="Up to 5, separated by commas.">
              <Input id="to" name="to" autoComplete="off" placeholder="you@example.com" />
            </Field>
          </div>
          <p className="text-[12px] text-muted">Many hosts (Hetzner included) block outgoing ports 25 and 465 on new servers; 587 usually works.</p>
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

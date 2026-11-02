"use client";

import { useActionState, useState } from "react";
import { createSiteAction, siteAction, type SiteActionState, type SiteFormState } from "@/app/actions/sites";
import { CopyButton, SubmitButton } from "./form";
import { SettingsRow } from "./page";
import { EngineTile } from "./sites";
import { Field, FormError, Input, cx } from "./ui";

const ENGINE_CHOICES = [
  { id: "wordpress", name: "WordPress", note: "PHP and MariaDB · about 15 MB idle" },
  { id: "ghost", name: "Ghost", note: "Node and MySQL 8 · about 200 MB" },
] as const;

/** New site: the engine, a title, and the owner, who's made during the install. */
export function NewSiteForm({ engine: initial }: { engine: "wordpress" | "ghost" }) {
  const [state, action] = useActionState(createSiteAction, {} as SiteFormState);
  const [engine, setEngine] = useState(initial);
  const err = state.errors ?? {};
  return (
    <form action={action}>
      <input type="hidden" name="engine" value={engine} />
      <SettingsRow title="Engine" description="Each site is its own install, with its own database: one can't touch another.">
        <div className="grid gap-2.5 sm:grid-cols-2">
          {ENGINE_CHOICES.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => setEngine(e.id)}
              aria-pressed={engine === e.id}
              data-testid={`engine-${e.id}`}
              className={cx("flex items-center gap-3 border p-3 text-left transition-colors duration-150", engine === e.id ? "border-accent bg-selected" : "border-border hover:border-border-strong")}
            >
              <EngineTile engine={e.id} />
              <span className="grid">
                <b>{e.name}</b>
                <span className="text-[12px] text-muted">{e.note}</span>
              </span>
            </button>
          ))}
        </div>
      </SettingsRow>
      <SettingsRow title="The site" description="Its title shows on the site. The name is its folder and Linux user on the server, and its free address.">
        <Field label="Title" htmlFor="title">
          <Input id="title" name="title" placeholder="My blog" aria-invalid={!!err.title} />
          {err.title && <FormError message={err.title} />}
        </Field>
        <Field label="Name (optional)" htmlFor="name" hint="Lowercase, like my-blog. Made from the title if empty.">
          <Input id="name" name="name" placeholder="my-blog" spellCheck={false} className="font-mono text-[13px]" aria-invalid={!!err.name} />
          {err.name && <FormError message={err.name} />}
        </Field>
      </SettingsRow>
      <SettingsRow title="Owner" description="The site's first account, made during the install so nobody else can claim it. Its password is shown once, on the site's page.">
        <Field label="Your name" htmlFor="ownerName">
          <Input id="ownerName" name="ownerName" aria-invalid={!!err.ownerName} />
          {err.ownerName && <FormError message={err.ownerName} />}
        </Field>
        <Field label="Email" htmlFor="ownerEmail">
          <Input id="ownerEmail" name="ownerEmail" type="email" aria-invalid={!!err.ownerEmail} />
          {err.ownerEmail && <FormError message={err.ownerEmail} />}
        </Field>
      </SettingsRow>
      <div className="grid justify-items-end gap-3 border-t border-border px-3.5 py-4">
        <FormError message={state.error} />
        <SubmitButton pending="Starting…" className="w-auto">
          Install {engine === "wordpress" ? "WordPress" : "Ghost"}
        </SubmitButton>
      </div>
    </form>
  );
}

/** One of the engine page's buttons, with what it said. */
export function SiteButton({ slug, op, label, pending, variant = "secondary", extra }: { slug: string; op: string; label: string; pending: string; variant?: "primary" | "secondary" | "danger"; extra?: Record<string, string> }) {
  const [state, action] = useActionState(siteAction, {} as SiteActionState);
  return (
    <form action={action} className="grid justify-items-start gap-2">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="op" value={op} />
      {Object.entries(extra ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <SubmitButton pending={pending} variant={variant} size="sm" className="w-auto">
        {label}
      </SubmitButton>
      <FormError message={state.error} />
      {state.saved && <p className="text-[12px] text-teal">{state.saved}</p>}
      {state.password && <Secret value={state.password} />}
    </form>
  );
}

/** A password shown once, with Copy. */
export function Secret({ value }: { value: string }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <code className="border border-border bg-field px-2 py-1 font-mono text-[13px]" data-testid="site-password">
        {value}
      </code>
      <CopyButton text={value} />
    </span>
  );
}

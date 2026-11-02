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

/**
 * Brings a WordPress in from another server: an archive with its wp-content
 * and a .sql dump. Uploaded with progress, then loaded as the site.
 */
export function WordpressImport({ slug }: { slug: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<"idle" | "uploading" | "importing" | "done" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const busy = phase === "uploading" || phase === "importing";
  const start = () => {
    if (!file) return;
    setPhase("uploading");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/projects/${slug}/import?confirm=${encodeURIComponent(typed)}&kind=wordpress`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(e.loaded / e.total);
    xhr.upload.onload = () => setPhase("importing");
    xhr.onload = () => {
      let body: { ok?: boolean; error?: string; oldUrl?: string; url?: string; replaced?: number } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // a proxy's error page
      }
      if (xhr.status === 200 && body.ok) {
        setMessage(`Imported${body.oldUrl ? ` ${body.oldUrl}` : ""}: its database and wp-content are in place${body.replaced ? `, and ${body.replaced} mentions of its old address now point here` : ""}. The site's previous wp-content is kept as wp-content.before-import.`);
        setPhase("done");
      } else {
        setMessage(body.error ?? `The import failed (HTTP ${xhr.status}).`);
        setPhase("error");
      }
    };
    xhr.onerror = () => {
      setMessage("The upload was interrupted. Nothing changed.");
      setPhase("error");
    };
    xhr.send(file);
  };
  return (
    <div className="grid gap-3" data-testid="wordpress-import">
      <label className="inline-flex h-9 w-fit max-w-full cursor-pointer items-center gap-2 border border-dashed border-border-strong px-3 text-[12px] text-muted hover:border-accent hover:text-foreground">
        <input type="file" accept=".zip,.tar.gz,.tgz,.tar" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <span className="truncate">{file ? file.name : "Choose a .zip or .tar.gz…"}</span>
      </label>
      {file && phase !== "done" && (
        <Field label={`Type ${slug} to replace this site's content and database`} htmlFor="wp-import-confirm">
          <Input id="wp-import-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
      )}
      {busy && <p className="text-[12px] text-muted">{phase === "uploading" ? `Uploading… ${Math.round(progress * 100)}%` : "Loading the database and files…"}</p>}
      {phase === "done" && <p className="text-[13px] text-teal">{message}</p>}
      {phase === "error" && <FormError message={message} />}
      {file && phase !== "done" && (
        <button type="button" onClick={start} disabled={busy || typed !== slug} className="w-fit border border-border px-3 py-1.5 text-[13px] font-bold disabled:opacity-50">
          {busy ? "Importing…" : "Import"}
        </button>
      )}
    </div>
  );
}

"use client";

import { useActionState, useState } from "react";
import { createSiteAction, siteAction, siteMailAction, type SiteActionState, type SiteFormState, type SiteMailState } from "@/app/actions/sites";
import { CopyButton, SubmitButton } from "./form";
import { SettingsRow } from "./page";
import { EngineTile } from "./sites";
import { Field, FormError, Input, SecretInput, cx } from "./ui";

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

/** How a WordPress site sends email: Email's API, an alert channel's SMTP, SMTP typed here, or not at all. */
export function SiteMailForm({
  slug,
  current,
  brands,
  channels,
  host,
  ip,
}: {
  slug: string;
  current: { kind: "api" | "smtp"; from: string } | null;
  /** The site's address, for the From and the SPF record. */
  host: string;
  ip: string | null;
  brands: { id: number; name: string; fromEmail: string | null }[] | null;
  channels: { id: number; name: string; host: string }[];
}) {
  const [state, action] = useActionState(siteMailAction, {} as SiteMailState);
  const [via, setVia] = useState<"server" | "email" | "alerts" | "smtp">(current ? (current.kind === "api" ? "email" : "smtp") : "server");
  const domain = host.replace(/^www\./, "");
  type Via = "server" | "email" | "alerts" | "smtp";
  const options: { id: Via; label: string }[] = [
    { id: "server", label: "This server (built in)" },
    ...(brands ? [{ id: "email" as const, label: "The Email integration" }] : []),
    ...(channels.length ? [{ id: "alerts" as const, label: "An alert channel's SMTP" }] : []),
    { id: "smtp", label: "An SMTP server" },
  ];
  return (
    <form action={action} className="grid gap-3" data-testid="site-mail">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="via" value={via === "server" ? "off" : via} />
      <p className="text-[13px]">
        {current ? (
          <>
            Sending from <b className="font-medium">{current.from}</b> ({current.kind === "api" ? "through Email" : "by SMTP"}).
          </>
        ) : (
          <>
            Sending from <b className="font-medium">wordpress@{domain}</b>, through this server&apos;s own mail: nothing to set up.
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button key={o.id} type="button" onClick={() => setVia(o.id)} aria-pressed={via === o.id} className={cx("border px-2.5 py-1 text-[12px]", via === o.id ? "border-accent bg-selected" : "border-border")}>
            {o.label}
          </button>
        ))}
      </div>
      {via === "server" && ip && (
        <p className="text-[12px] text-muted">
          To keep it out of spam folders, add a TXT record at <code className="font-mono">{domain}</code>: <code className="font-mono text-foreground">v=spf1 ip4:{ip} ~all</code> (or add <code className="font-mono">ip4:{ip}</code> to the SPF record it has).
          {/\.(sslip\.io|nip\.io|internal)$/.test(domain) ? " A free address can't have one: mail from it often lands in spam, so give the site its own domain." : ""}
        </p>
      )}
      {via === "email" &&
        (brands?.length ? (
          <Field label="Brand" htmlFor="mail-brand" hint="The site sends as this brand, with a key of its own.">
            <select id="mail-brand" name="brand" className="h-[39px] w-full max-w-[340px] border border-border bg-field px-2.5">
              {brands.map((b) => (
                <option key={b.id} value={b.id} disabled={!b.fromEmail}>
                  {b.name} {b.fromEmail ? `(${b.fromEmail})` : "(no From address yet)"}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <p className="text-[12px] text-muted">Email has no brands yet: add one in Email first.</p>
        ))}
      {via === "alerts" && (
        <Field label="Alert channel" htmlFor="mail-channel" hint="Its SMTP server and From address; the alerts keep using it too.">
          <select id="mail-channel" name="channel" className="h-[39px] w-full max-w-[340px] border border-border bg-field px-2.5">
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.host})
              </option>
            ))}
          </select>
        </Field>
      )}
      {via === "smtp" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Host" htmlFor="mail-host">
            <Input id="mail-host" name="host" placeholder="smtp.resend.com" />
          </Field>
          <Field label="Port" htmlFor="mail-port">
            <Input id="mail-port" name="port" defaultValue="587" inputMode="numeric" />
          </Field>
          <Field label="Username" htmlFor="mail-user">
            <Input id="mail-user" name="user" />
          </Field>
          <Field label="Password" htmlFor="mail-password">
            <SecretInput id="mail-password" name="password" />
          </Field>
          <Field label="Connection" htmlFor="mail-secure">
            <select id="mail-secure" name="secure" defaultValue="tls" className="h-[39px] w-full border border-border bg-field px-2.5">
              <option value="tls">STARTTLS (587)</option>
              <option value="ssl">TLS (465)</option>
              <option value="">None (a relay on this server)</option>
            </select>
          </Field>
          <Field label="From" htmlFor="mail-from">
            <Input id="mail-from" name="from" placeholder="hello@example.com" />
          </Field>
        </div>
      )}
      <FormError message={state.error} />
      {state.saved && <p className="text-[13px] text-teal">{state.saved}</p>}
      <SubmitButton pending="Saving…" className="w-fit" size="sm">
        Save
      </SubmitButton>
    </form>
  );
}

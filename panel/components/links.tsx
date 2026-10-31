"use client";

import { ChartColumnIcon, LockIcon, PencilIcon, PlusIcon, QrCodeIcon } from "lucide-react";
import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { renderSVG } from "uqr";
import { createApiToken, deleteLink, importLinks, revokeApiToken, saveLink, saveLinksSettings, setLinkDisabled, type ImportState, type LinkFormState, type LinksSettingsState, type QuickState, type TokenState } from "@/app/actions/links";
import type { LinksSettings, Link as ShortLink, Redirect } from "@/lib/links";
import { CopyButton, SubmitButton } from "./form";
import { Icon } from "./icon";
import { MENU_ITEM, MoreMenu } from "./menu";
import { Modal } from "./modal";
import { SettingsRow } from "./page";
import { Button, Field, FormError, Input, SecretInput, Select, cx } from "./ui";

const Err = ({ msg }: { msg?: string }) => (msg ? <p className="text-[12px] text-rose">{msg}</p> : null);

/** The value a datetime-local field shows for a moment, in the browser's own time zone. */
const localInput = (ms: number | null) => {
  if (!ms) return "";
  const d = new Date(ms);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

const REDIRECTS: [Redirect, string][] = [
  [302, "302 · counts every click"],
  [307, "307 · same, keeps the method"],
  [301, "301 · browsers cache it a day"],
  [308, "308 · cached, keeps the method"],
];

function SaveButton({ editing }: { editing: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving…" : editing ? "Save" : "Create link"}
    </Button>
  );
}

/** Creates a link (no link given) or edits one. */
export function LinkDialog({ slug, domain, link, defaultRedirect, onClose }: { slug: string; domain: string; link?: ShortLink; defaultRedirect: Redirect; onClose: () => void }) {
  const [state, action] = useActionState(saveLink, {} as LinkFormState);
  const [expires, setExpires] = useState(localInput(link?.expiresAt ?? null));
  useEffect(() => {
    if (state.saved) onClose();
  }, [state.saved, onClose]);
  const e = (field: string) => (state.field === field ? state.error : undefined);
  const general = state.error && !["target", "slug", "title", "tags", "redirect", "password", "expiresAt"].includes(state.field ?? "") ? state.error : undefined;
  return (
    <Modal open onClose={onClose} title={link ? `Edit ${domain}/${link.slug}` : "New link"} description={link ? `${link.clicks} click${link.clicks === 1 ? "" : "s"} so far` : `On ${domain}`}>
      <form action={action} className="grid gap-4 px-[18px] py-5" data-testid="link-form">
        <input type="hidden" name="slug" value={slug} />
        {link && <input type="hidden" name="id" value={link.id} />}
        <input type="hidden" name="expiresAt" value={expires ? new Date(expires).toISOString() : ""} />
        <Field label="Where it goes" htmlFor="target">
          <Input id="target" name="target" type="url" required defaultValue={link?.target} placeholder="https://example.com/a-long-page" spellCheck={false} autoFocus={!link} />
          <Err msg={e("target")} />
        </Field>
        <Field label="Short link" htmlFor="path" hint={link ? "Changing it breaks the old short link" : "Empty: 7 random letters and digits"}>
          <div className="flex items-center border border-border bg-field focus-within:border-accent">
            <span className="whitespace-nowrap pl-3 text-muted">{domain}/</span>
            <input id="path" name="path" defaultValue={link?.slug} placeholder="launch" spellCheck={false} autoComplete="off" className="h-[37px] min-w-0 flex-1 bg-transparent pr-3 outline-none" />
          </div>
          <Err msg={e("slug")} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" htmlFor="title" hint="For you; visitors don't see it">
            <Input id="title" name="title" defaultValue={link?.title} placeholder="Launch post" />
            <Err msg={e("title")} />
          </Field>
          <Field label="Tags" htmlFor="tags" hint="Comma-separated">
            <Input id="tags" name="tags" defaultValue={link?.tags.join(", ")} placeholder="launch, twitter" spellCheck={false} />
            <Err msg={e("tags")} />
          </Field>
        </div>
        <fieldset className="grid gap-1.5">
          <legend className="mb-1.5 text-[12px] text-muted">Redirect</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {REDIRECTS.map(([code, label]) => (
              <label key={code} className="flex items-center gap-2 text-[13px]">
                <input type="radio" name="redirect" value={code} defaultChecked={(link?.redirect ?? defaultRedirect) === code} className="accent-accent" />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2.5 text-[13px]">
          <input type="checkbox" name="passQuery" defaultChecked={link?.passQuery ?? true} className="size-4 shrink-0 accent-accent" />
          <span>
            Pass the visitor&apos;s query string on: <code className="font-mono text-[12px]">?ref=x</code> is added to the target
          </span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Password" htmlFor="password" hint={link?.hasPassword ? "Has one. Empty keeps it" : "Optional: visitors type it first"}>
            <SecretInput id="password" name="password" placeholder={link?.hasPassword ? "••••••••" : "None"} />
            {link?.hasPassword && (
              <label className="mt-1 flex items-center gap-2 text-[12px] text-muted">
                <input type="checkbox" name="removePassword" className="accent-rose" /> Remove the password
              </label>
            )}
            <Err msg={e("password")} />
          </Field>
          <Field label="Expires" htmlFor="expires" hint="Optional: then it answers “not active”">
            <Input id="expires" type="datetime-local" value={expires} onChange={(ev) => setExpires(ev.target.value)} />
            <Err msg={e("expiresAt")} />
          </Field>
        </div>
        {link && (
          <label className="flex items-center gap-2.5 text-[13px]">
            <input type="checkbox" name="disabled" defaultChecked={link.disabled} className="size-4 accent-accent" />
            Turned off (visitors see “not active”)
          </label>
        )}
        <FormError message={general} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <SaveButton editing={!!link} />
        </div>
      </form>
    </Modal>
  );
}

export function NewLinkButton({ slug, domain, defaultRedirect }: { slug: string; domain: string; defaultRedirect: Redirect }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="new-link">
        <Icon icon={PlusIcon} size={16} /> New link
      </Button>
      {open && <LinkDialog slug={slug} domain={domain} defaultRedirect={defaultRedirect} onClose={() => setOpen(false)} />}
    </>
  );
}

function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** The short link as a QR code, to download as SVG or a 1024px PNG. */
function QrDialog({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const svg = renderSVG(url, { border: 2, ecc: "M" });
  const png = () => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1024;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, 1024, 1024);
      canvas.toBlob((b) => b && download(`${name}.png`, b), "image/png");
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  };
  return (
    <Modal open onClose={onClose} title="QR code" description={url}>
      <div className="grid justify-items-center gap-4 px-[18px] py-5">
        {/* White behind the code in both themes: scanners need the contrast. */}
        <div className="w-[min(280px,70vw)] bg-white p-2 [&_svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => download(`${name}.svg`, new Blob([svg], { type: "image/svg+xml" }))}>
            Download SVG
          </Button>
          <Button variant="secondary" onClick={png}>
            Download PNG
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DeleteLinkDialog({ slug, link, onClose }: { slug: string; link: ShortLink; onClose: () => void }) {
  const [state, action] = useActionState(deleteLink, {} as QuickState);
  const [typed, setTyped] = useState("");
  return (
    <Modal open onClose={onClose} title={`Delete /${link.slug}`} description="This can't be undone">
      <form action={action} className="grid gap-4 px-[18px] py-5">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="id" value={link.id} />
        <input type="hidden" name="path" value={link.slug} />
        <p className="text-[12px] text-muted">The short link stops working at once, and its {link.clicks} click{link.clicks === 1 ? "" : "s"} leave the stats.</p>
        <Field label={`Type ${link.slug} to confirm`} htmlFor="confirm">
          <Input id="confirm" name="confirm" value={typed} onChange={(ev) => setTyped(ev.target.value)} autoFocus spellCheck={false} />
        </Field>
        <FormError message={state.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={typed.toLowerCase() !== link.slug}>
            Delete link
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** A row's buttons: QR code, edit, and a menu (stats, turn off or on, delete). */
export function LinkActions({ slug, domain, link, defaultRedirect }: { slug: string; domain: string; link: ShortLink; defaultRedirect: Redirect }) {
  const [open, setOpen] = useState<"qr" | "edit" | "delete" | null>(null);
  const [toggleState, toggle] = useActionState(setLinkDisabled, {} as QuickState);
  const iconButton = "grid size-[26px] place-items-center border border-border text-muted transition-colors hover:bg-btn-hover hover:text-foreground";
  return (
    <div className="relative flex items-center justify-end gap-1.5">
      <button type="button" className={iconButton} aria-label={`QR code for /${link.slug}`} title="QR code" onClick={() => setOpen("qr")}>
        <Icon icon={QrCodeIcon} size={14} />
      </button>
      <button type="button" className={iconButton} aria-label={`Edit /${link.slug}`} title="Edit" onClick={() => setOpen("edit")} data-testid={`edit-${link.slug}`}>
        <Icon icon={PencilIcon} size={13} />
      </button>
      <MoreMenu label={`More for /${link.slug}`} buttonClassName={iconButton}>
        {(close) => (
          <>
            <Link role="menuitem" className={MENU_ITEM} href={`/projects/${slug}/stats?link=${link.id}`} onClick={close}>
              <Icon icon={ChartColumnIcon} size={14} /> Stats
            </Link>
            <form action={toggle}>
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="id" value={link.id} />
              <input type="hidden" name="disabled" value={String(!link.disabled)} />
              <button type="submit" role="menuitem" className={MENU_ITEM} onClick={() => setTimeout(close, 0)}>
                {link.disabled ? "Turn on" : "Turn off"}
              </button>
            </form>
            <button type="button" role="menuitem" className={cx(MENU_ITEM, "text-rose")} onClick={() => (close(), setOpen("delete"))}>
              Delete…
            </button>
          </>
        )}
      </MoreMenu>
      {toggleState.error && <span className="absolute right-0 top-8 z-10 bg-card px-2 text-[12px] text-rose">{toggleState.error}</span>}
      {open === "qr" && <QrDialog url={`https://${domain}/${link.slug}`} name={link.slug} onClose={() => setOpen(null)} />}
      {open === "edit" && <LinkDialog slug={slug} domain={domain} link={link} defaultRedirect={defaultRedirect} onClose={() => setOpen(null)} />}
      {open === "delete" && <DeleteLinkDialog slug={slug} link={link} onClose={() => setOpen(null)} />}
    </div>
  );
}

export const PasswordMark = () => (
  <span title="Needs a password" className="inline-flex text-muted">
    <Icon icon={LockIcon} size={12} />
  </span>
);

/** Makes an API token and shows it once. */
export function NewTokenForm({ slug }: { slug: string }) {
  const [state, action] = useActionState(createApiToken, {} as TokenState);
  return (
    <div className="grid gap-2">
      <form action={action} className="flex gap-2" data-testid="new-token">
        <input type="hidden" name="slug" value={slug} />
        <Input name="name" placeholder="What it's for, like zapier" required aria-label="Token name" className="h-[35px] min-w-0 sm:w-[220px]" />
        <SubmitButton pending="Making…" className="w-auto">
          New token
        </SubmitButton>
      </form>
      <FormError message={state.error} />
      {state.token && (
        <div className="grid gap-1.5 border border-ok-line px-3 py-2.5" data-testid="token-once">
          <span className="text-[12px] text-muted">
            <b className="text-teal">{state.name}</b>: copy it now, it won&apos;t be shown again.
          </span>
          <span className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{state.token}</code>
            <CopyButton text={state.token} />
          </span>
        </div>
      )}
    </div>
  );
}

export function RevokeTokenButton({ slug, id, name }: { slug: string; id: number; name: string }) {
  const [state, action] = useActionState(revokeApiToken, {} as QuickState);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(`Revoke ${name}? Anything using it stops working.`)) e.preventDefault();
      }}
      className="justify-self-end"
    >
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="danger" size="sm">
        Revoke
      </Button>
      {state.error && <p className="text-[12px] text-rose">{state.error}</p>}
    </form>
  );
}

/** A CSV file of links, from Links or another shortener; says which lines were skipped and why. */
export function ImportLinksForm({ slug }: { slug: string }) {
  const [state, action] = useActionState(importLinks, {} as ImportState);
  return (
    <form action={action} className="grid gap-2.5" data-testid="import-links">
      <input type="hidden" name="slug" value={slug} />
      <div className="flex flex-wrap items-center gap-2">
        <input type="file" name="file" accept=".csv,text/csv" required className="min-w-0 text-[13px] file:mr-3 file:h-[26px] file:cursor-pointer file:border file:border-border file:bg-transparent file:px-2.5 file:text-[12px] file:text-foreground" />
        <SubmitButton pending="Importing…" variant="secondary" size="sm" className="w-auto">
          Import
        </SubmitButton>
      </div>
      <FormError message={state.error} />
      {state.result && (
        <div className="grid gap-1 text-[12px]">
          <span className="text-teal">
            Imported {state.result.created} link{state.result.created === 1 ? "" : "s"}
            {state.result.skipped.length ? `; skipped ${state.result.skipped.length}:` : "."}
          </span>
          {state.result.skipped.slice(0, 20).map((s) => (
            <span key={s.line} className="text-muted">
              Line {s.line}: {s.reason}
            </span>
          ))}
          {state.result.skipped.length > 20 && <span className="text-dim">and {state.result.skipped.length - 20} more</span>}
        </div>
      )}
    </form>
  );
}

/** Links' own settings (kept in its database, used at once): where the bare domain and unknown slugs go, new links' redirect, how long raw clicks stay. */
export function LinksSettingsForm({ slug, domain, settings }: { slug: string; domain: string; settings: LinksSettings }) {
  const [state, action] = useActionState(saveLinksSettings, {} as LinksSettingsState);
  const e = (field: string) => (state.field === field ? state.error : undefined);
  return (
    <form action={action} data-testid="links-settings">
      <input type="hidden" name="slug" value={slug} />
      <SettingsRow title="Links" description={`What ${domain} does besides your short links. Saved in Links and used at once.`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`${domain} itself goes to`} htmlFor="home" hint="Empty: a short page that says it serves short links">
            <Input id="home" name="home" type="url" defaultValue={settings.home} placeholder="https://example.com" spellCheck={false} />
            <Err msg={e("home")} />
          </Field>
          <Field label="Unknown links go to" htmlFor="missing" hint="Empty: a plain “not found” page">
            <Input id="missing" name="missing" type="url" defaultValue={settings.missing} placeholder="https://example.com" spellCheck={false} />
            <Err msg={e("missing")} />
          </Field>
          <Field label="New links redirect with" htmlFor="defaultRedirect">
            <Select id="defaultRedirect" name="defaultRedirect" defaultValue={String(settings.defaultRedirect)}>
              {REDIRECTS.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Keep each click for (days)" htmlFor="keepDays" hint="Older clicks become daily totals: stats stay, details go">
            <Input id="keepDays" name="keepDays" type="number" min={1} max={3650} defaultValue={settings.keepDays} className="max-w-[160px] tabular-nums" />
            <Err msg={e("keepDays")} />
          </Field>
        </div>
      </SettingsRow>
      <div className="grid gap-3 border-b border-border px-3.5 py-5">
        <FormError message={state.field ? undefined : state.error} />
        {state.saved && <p className="text-right text-[13px] text-teal">{state.saved}</p>}
        <div className="flex justify-end">
          <SubmitButton pending="Saving…" className="w-auto">
            Save
          </SubmitButton>
        </div>
      </div>
    </form>
  );
}

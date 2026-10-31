"use client";

// Email's forms: brands, providers, domains, lists and contacts, the editor
// campaigns, templates and automation emails share (Markdown or HTML, with a
// preview as a contact would see it), and API keys.
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon, UploadIcon } from "lucide-react";
import { useActionState, useEffect, useMemo, useState, type ReactNode } from "react";
import * as A from "@/app/actions/email";
import type { Automation, Brand, Campaign, List, Step, Template } from "@/lib/email";
import { markdownEmail, sampleMerge } from "@/lib/markdown";
import { CopyButton, SubmitButton } from "./form";
import { Icon } from "./icon";
import { MENU_ITEM, MoreMenu } from "./menu";
import { Modal } from "./modal";
import { Button, Field, FormError, Input, SecretInput, Select, cx } from "./ui";

const initial: A.FormState = {};
type Action = (prev: A.FormState, form: FormData) => Promise<A.FormState>;

function Saved({ state }: { state: A.FormState }) {
  return (
    <>
      <FormError message={state.error} />
      {state.saved && <p className="text-[13px] text-teal">{state.saved}</p>}
    </>
  );
}

const Hidden = ({ values }: { values: Record<string, string | number> }) => (
  <>
    {Object.entries(values).map(([k, v]) => (
      <input key={k} type="hidden" name={k} value={v} />
    ))}
  </>
);

/** A dialog that closes once its action saved. */
function DialogForm({ title, description, action, onClose, children, submit, testId }: { title: string; description?: string; action: Action; onClose: () => void; children: ReactNode; submit: string; testId?: string }) {
  const [state, run] = useActionState(action, initial);
  useEffect(() => {
    if (state.saved) onClose();
  }, [state, onClose]);
  return (
    <Modal open onClose={onClose} title={title} description={description}>
      <form action={run} className="grid gap-4 px-[18px] py-5" data-testid={testId}>
        {children}
        <FormError message={state.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <SubmitButton pending="Saving…" className="w-auto">
            {submit}
          </SubmitButton>
        </div>
      </form>
    </Modal>
  );
}

function ListChecks({ lists, name, checked = [], none }: { lists: List[]; name: string; checked?: number[]; none?: string }) {
  if (!lists.length) return <p className="text-[12px] text-muted">{none ?? "No lists yet."}</p>;
  return (
    <div className="grid gap-1.5">
      {lists.map((l) => (
        <label key={l.id} className="flex items-center gap-2.5 text-[13px]">
          <input type="checkbox" name={name} value={l.id} defaultChecked={checked.includes(l.id)} className="size-4 accent-accent" />
          {l.name} <span className="text-dim">{l.subscribed.toLocaleString("en")}</span>
        </label>
      ))}
    </div>
  );
}

// Brands

function BrandFields() {
  return (
    <>
      <Field label="Name" htmlFor="brand-name" hint="Your product, as recipients know it">
        <Input id="brand-name" name="name" required placeholder="Piqo" autoFocus />
      </Field>
      <Field label="From address" htmlFor="brand-from" hint="On a domain you'll verify; you can change it later">
        <Input id="brand-from" name="fromEmail" type="email" placeholder="hello@piqo.app" spellCheck={false} />
      </Field>
    </>
  );
}

export function AddBrandDialog({ onClose }: { onClose: () => void }) {
  return (
    <DialogForm title="Add a brand" description="A product with its own domains, contacts and campaigns" action={A.addBrand} onClose={onClose} submit="Add brand" testId="add-brand">
      <BrandFields />
    </DialogForm>
  );
}

export function FirstBrand() {
  const [state, run] = useActionState(A.addBrand, initial);
  return (
    <form action={run} className="mx-auto grid w-full max-w-[520px] gap-3 px-3.5 py-6" data-testid="add-brand">
      <BrandFields />
      <FormError message={state.error} />
      <div>
        <SubmitButton pending="Adding…" className="w-auto">
          Add brand
        </SubmitButton>
      </div>
    </form>
  );
}

export function BrandForm({ brand }: { brand: Brand }) {
  const [state, run] = useActionState(A.saveBrand, initial);
  return (
    <form action={run} className="grid gap-3">
      <Hidden values={{ brand: brand.id }} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="b-name">
          <Input id="b-name" name="name" required defaultValue={brand.name} />
        </Field>
        <Field label="Website" htmlFor="b-site">
          <Input id="b-site" name="website" defaultValue={brand.website} placeholder="https://piqo.app" />
        </Field>
        <Field label="From name" htmlFor="b-fromname">
          <Input id="b-fromname" name="fromName" defaultValue={brand.fromName} placeholder="Piqo" />
        </Field>
        <Field label="From address" htmlFor="b-from" hint="On a verified domain">
          <Input id="b-from" name="fromEmail" type="email" defaultValue={brand.fromEmail} placeholder="hello@piqo.app" spellCheck={false} />
        </Field>
        <Field label="Reply-to" htmlFor="b-reply" hint="Optional: where replies go">
          <Input id="b-reply" name="replyTo" type="email" defaultValue={brand.replyTo} spellCheck={false} />
        </Field>
      </div>
      <Field label="Postal address" htmlFor="b-address" hint="The law in many countries (CAN-SPAM, GDPR) wants it in every newsletter's footer">
        <textarea id="b-address" name="address" rows={2} defaultValue={brand.address} className="w-full border border-border bg-field px-2.5 py-2 outline-none focus:border-accent" />
      </Field>
      <Saved state={state} />
      <div>
        <SubmitButton pending="Saving…" className="w-auto">
          Save
        </SubmitButton>
      </div>
    </form>
  );
}

export function SendingForm({ brand }: { brand: Brand }) {
  const [state, run] = useActionState(A.saveSending, initial);
  return (
    <form action={run} className="grid gap-3">
      <Hidden values={{ brand: brand.id }} />
      <Field label="Emails a second, at most" htmlFor="b-rate" hint="Amazon SES gives each account its own rate (1 a second in the sandbox); most SMTP providers allow 5 to 50">
        <Input id="b-rate" name="rate" type="number" min={0.1} max={500} step="any" defaultValue={brand.rate} className="max-w-[160px] tabular-nums" />
      </Field>
      <label className="flex items-center gap-2.5 text-[13px]">
        <input type="checkbox" name="trackOpens" defaultChecked={brand.trackOpens} className="size-4 accent-accent" /> Count opens (a tiny image in campaigns and automations)
      </label>
      <label className="flex items-center gap-2.5 text-[13px]">
        <input type="checkbox" name="trackClicks" defaultChecked={brand.trackClicks} className="size-4 accent-accent" /> Count clicks (links go through this server first)
      </label>
      <p className="text-[12px] text-muted">Transactional emails from the API are never tracked, so their links go straight where they say.</p>
      <Saved state={state} />
      <div>
        <SubmitButton pending="Saving…" className="w-auto">
          Save
        </SubmitButton>
      </div>
    </form>
  );
}

export function ProviderForm({ brand }: { brand: Brand }) {
  const [state, run] = useActionState(A.saveProvider, initial);
  const [kind, setKind] = useState(brand.provider === "none" ? "smtp" : brand.provider);
  return (
    <form action={run} className="grid gap-3" data-testid="provider-form">
      <Hidden values={{ brand: brand.id }} />
      <Field label="Send with" htmlFor="p-kind">
        <Select id="p-kind" name="provider" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="max-w-[260px]">
          <option value="smtp">SMTP (any provider)</option>
          <option value="ses">Amazon SES (its API)</option>
          {brand.provider !== "none" && <option value="none">Nothing (disconnect)</option>}
        </Select>
      </Field>
      {kind === "smtp" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Host" htmlFor="p-host" hint="smtp.postmarkapp.com, email-smtp.us-east-1.amazonaws.com…">
            <Input id="p-host" name="host" required defaultValue={brand.smtp?.host} placeholder="smtp.example.com" spellCheck={false} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Port" htmlFor="p-port" hint="587, or 465">
              <Input id="p-port" name="port" type="number" defaultValue={brand.smtp?.port ?? 587} className="tabular-nums" />
            </Field>
            <Field label="Security" htmlFor="p-sec">
              <Select id="p-sec" name="security" defaultValue={brand.smtp?.security ?? "starttls"}>
                <option value="starttls">STARTTLS</option>
                <option value="tls">TLS</option>
                <option value="none">None</option>
              </Select>
            </Field>
          </div>
          <Field label="Username" htmlFor="p-user">
            <Input id="p-user" name="username" defaultValue={brand.smtp?.username} spellCheck={false} />
          </Field>
          <Field label="Password" htmlFor="p-pass" hint={brand.smtp?.hasPassword ? "Leave empty to keep the one in use" : undefined}>
            <SecretInput id="p-pass" name="password" placeholder={brand.smtp?.hasPassword ? "••••••••" : ""} />
          </Field>
        </div>
      )}
      {kind === "ses" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Region" htmlFor="p-region" hint="Where SES is set up: us-east-1, eu-west-1…">
            <Input id="p-region" name="region" required defaultValue={brand.ses?.region ?? "us-east-1"} spellCheck={false} />
          </Field>
          <Field label="Access key ID" htmlFor="p-akid" hint="An IAM user's key, allowed SES and SNS">
            <Input id="p-akid" name="accessKeyId" required defaultValue={brand.ses?.accessKeyId} placeholder="AKIA…" spellCheck={false} />
          </Field>
          <Field label="Secret access key" htmlFor="p-secret" hint={brand.ses?.hasSecret ? "Leave empty to keep the one in use" : undefined}>
            <SecretInput id="p-secret" name="secretAccessKey" placeholder={brand.ses?.hasSecret ? "••••••••" : ""} />
          </Field>
        </div>
      )}
      <p className="text-[12px] text-muted">Passwords and keys are kept encrypted. Many servers can&apos;t send on port 25 (Hetzner blocks 25 and 465 for new accounts): use 587.</p>
      <Saved state={state} />
      <div>
        <SubmitButton pending="Saving…" className="w-auto">
          Save
        </SubmitButton>
      </div>
    </form>
  );
}

export function ProviderTools({ brand }: { brand: Brand }) {
  const [check, runCheck] = useActionState(A.checkProvider, initial);
  const [test, runTest] = useActionState(A.sendTestEmail, initial);
  return (
    <div className="grid gap-3">
      <form action={runTest} className="flex flex-wrap items-end gap-2" data-testid="test-email">
        <Hidden values={{ brand: brand.id }} />
        <Field label="Send a test to" htmlFor="t-to">
          <Input id="t-to" name="to" type="email" required placeholder="you@example.com" className="sm:w-[260px]" />
        </Field>
        <SubmitButton pending="Sending…" variant="secondary" className="w-auto">
          Send test
        </SubmitButton>
      </form>
      <Saved state={test} />
      <form action={runCheck} className="flex flex-wrap items-center gap-2.5">
        <Hidden values={{ brand: brand.id }} />
        <SubmitButton pending="Connecting…" variant="secondary" size="sm" className="w-auto">
          Check the connection
        </SubmitButton>
        <span className="text-[12px] text-muted">{brand.provider === "ses" ? "Reads the account's quota and sandbox state" : "Connects and logs in, sending nothing"}</span>
      </form>
      <Saved state={check} />
    </div>
  );
}

export function SesEventsButton({ brandId, ready }: { brandId: number; ready: boolean }) {
  const [state, run] = useActionState(A.setUpSesEvents, initial);
  return (
    <form action={run} className="grid gap-2">
      <Hidden values={{ brand: brandId }} />
      <div>
        <SubmitButton pending="Setting up…" variant={ready ? "secondary" : "primary"} className="w-auto">
          {ready ? "Set it up again" : "Set up bounce handling"}
        </SubmitButton>
      </div>
      <Saved state={state} />
    </form>
  );
}

export function DeleteBrand({ brand }: { brand: Brand }) {
  const [state, run] = useActionState(A.removeBrand, initial);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  return (
    <>
      <Button type="button" variant="secondary" size="sm" className="border-rose/60 text-rose hover:bg-rose/10" onClick={() => setOpen(true)}>
        Delete {brand.name}…
      </Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title={`Delete ${brand.name}`} description="This can't be undone">
          <form action={run} className="grid gap-4 px-[18px] py-5">
            <Hidden values={{ brand: brand.id, name: brand.name }} />
            <p className="text-[12px] text-muted">Its contacts, lists, campaigns, automations, templates, keys, domains and logs are deleted. Nothing more is sent for it.</p>
            <Field label={`Type ${brand.name} to confirm`} htmlFor="confirm">
              <Input id="confirm" name="confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus spellCheck={false} />
            </Field>
            <FormError message={state.error} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="danger" disabled={typed !== brand.name}>
                Delete brand
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

// Domains

export function AddDomainForm({ brandId }: { brandId: number }) {
  const [state, run] = useActionState(A.addDomain, initial);
  return (
    <form action={run} className="grid gap-2" data-testid="add-domain">
      <Hidden values={{ brand: brandId }} />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Domain" htmlFor="d-domain" hint="The part after @ in your From address">
          <Input id="d-domain" name="domain" required placeholder="piqo.app" spellCheck={false} className="sm:w-[280px]" />
        </Field>
        <SubmitButton pending="Adding…" className="w-auto">
          Add domain
        </SubmitButton>
      </div>
      <Saved state={state} />
    </form>
  );
}

export function DomainButtons({ brandId, id, domain }: { brandId: number; id: number; domain: string }) {
  const [state, run] = useActionState(A.verifyDomain, initial);
  const [, remove] = useActionState(A.removeDomain, initial);
  return (
    <div className="grid justify-items-end gap-1">
      <div className="flex items-center gap-1.5">
        <form action={run}>
          <Hidden values={{ brand: brandId, id }} />
          <SubmitButton pending="Checking…" variant="secondary" size="sm" className="w-auto">
            Check
          </SubmitButton>
        </form>
        <MoreMenu label={`${domain}: more`} buttonClassName="grid size-[26px] place-items-center text-muted hover:bg-hover hover:text-foreground">
          {() => (
            <form action={remove} onSubmit={(e) => !confirm(`Remove ${domain}? Mail from it stops until it's added again.`) && e.preventDefault()}>
              <Hidden values={{ brand: brandId, id }} />
              <button type="submit" role="menuitem" className={cx(MENU_ITEM, "text-rose")}>
                Remove
              </button>
            </form>
          )}
        </MoreMenu>
      </div>
      {state.error && <p className="max-w-[320px] text-right text-[12px] text-rose">{state.error}</p>}
      {state.saved && <p className="text-[12px] text-teal">{state.saved}</p>}
    </div>
  );
}

// Lists and contacts

function ListFields({ list }: { list?: List }) {
  return (
    <>
      <Field label="Name" htmlFor="l-name">
        <Input id="l-name" name="name" required defaultValue={list?.name} placeholder="Newsletter" autoFocus />
      </Field>
      <Field label="Description" htmlFor="l-desc" hint="Optional, for you">
        <Input id="l-desc" name="description" defaultValue={list?.description} />
      </Field>
      <label className="flex items-center gap-2.5 text-[13px]">
        <input type="checkbox" name="doubleOptIn" defaultChecked={list?.doubleOptIn} className="size-4 accent-accent" /> Double opt-in: signups from the form confirm by email first
      </label>
    </>
  );
}

export function NewListButton({ brandId }: { brandId: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="new-list">
        <Icon icon={PlusIcon} size={16} /> New list
      </Button>
      {open && (
        <DialogForm title="New list" action={A.saveList} onClose={() => setOpen(false)} submit="Add list" testId="list-form">
          <Hidden values={{ brand: brandId }} />
          <ListFields />
        </DialogForm>
      )}
    </>
  );
}

export function ListActions({ brandId, list }: { brandId: number; list: List }) {
  const [editing, setEditing] = useState(false);
  const [, remove] = useActionState(A.removeList, initial);
  return (
    <>
      <MoreMenu label={`${list.name}: more`} buttonClassName="grid size-7 place-items-center text-muted hover:bg-hover hover:text-foreground">
        {(close) => (
          <>
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => {
                close();
                setEditing(true);
              }}
            >
              Change…
            </button>
            <form action={remove} onSubmit={(e) => !confirm(`Delete the list ${list.name}? Its contacts stay.`) && e.preventDefault()}>
              <Hidden values={{ brand: brandId, id: list.id }} />
              <button type="submit" role="menuitem" className={cx(MENU_ITEM, "text-rose")}>
                Delete
              </button>
            </form>
          </>
        )}
      </MoreMenu>
      {editing && (
        <DialogForm title={`Change ${list.name}`} action={A.saveList} onClose={() => setEditing(false)} submit="Save">
          <Hidden values={{ brand: brandId, id: list.id }} />
          <ListFields list={list} />
        </DialogForm>
      )}
    </>
  );
}

export function ContactButtons({ brandId, lists }: { brandId: number; lists: List[] }) {
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [state, run] = useActionState(A.importContacts, initial);
  return (
    <>
      <Button variant="secondary" onClick={() => setImporting(true)} data-testid="import-contacts">
        <Icon icon={UploadIcon} size={15} /> Import
      </Button>
      <Button onClick={() => setAdding(true)} data-testid="new-contact">
        <Icon icon={PlusIcon} size={16} /> Add contact
      </Button>
      {adding && (
        <DialogForm title="Add a contact" description="Subscribed, as they asked you" action={A.addContact} onClose={() => setAdding(false)} submit="Add contact" testId="contact-form">
          <Hidden values={{ brand: brandId }} />
          <Field label="Email" htmlFor="c-email">
            <Input id="c-email" name="email" type="email" required autoFocus spellCheck={false} />
          </Field>
          <Field label="Name" htmlFor="c-name">
            <Input id="c-name" name="name" />
          </Field>
          <ListChecks lists={lists} name="lists" />
        </DialogForm>
      )}
      {importing && (
        <Modal open onClose={() => setImporting(false)} title="Import contacts" description="From a CSV with an email column">
          <form action={run} className="grid gap-4 px-[18px] py-5" data-testid="import-form">
            <Hidden values={{ brand: brandId }} />
            <Field label="CSV file" htmlFor="i-file" hint="Columns: email, name (or first and last name); every other column becomes a field">
              <input id="i-file" name="file" type="file" accept=".csv,text/csv" required className="text-[13px]" />
            </Field>
            <div className="grid gap-1.5">
              <span className="text-[13px] font-bold">Add them to</span>
              <ListChecks lists={lists} name="lists" none="No lists yet: they're added as contacts only." />
            </div>
            <p className="text-[12px] text-muted">Import only people who asked for your emails. Nobody who unsubscribed is subscribed again, and imports start no automation.</p>
            <Saved state={state} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setImporting(false)}>
                Close
              </Button>
              <SubmitButton pending="Importing…" className="w-auto">
                Import
              </SubmitButton>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

export function ContactForm({ brandId, contact, lists }: { brandId: number; contact: { id: number; email: string; name: string; status: string; fields: Record<string, string>; lists: number[] }; lists: List[] }) {
  const [state, run] = useActionState(A.saveContact, initial);
  const [, remove] = useActionState(A.removeContact, initial);
  return (
    <div className="grid gap-4">
      <form action={run} className="grid gap-3" data-testid="contact-edit">
        <Hidden values={{ brand: brandId, id: contact.id }} />
        {contact.lists.map((l) => (
          <input key={l} type="hidden" name="had" value={l} />
        ))}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email" htmlFor="ce-email">
            <Input id="ce-email" name="email" type="email" defaultValue={contact.email} spellCheck={false} />
          </Field>
          <Field label="Name" htmlFor="ce-name">
            <Input id="ce-name" name="name" defaultValue={contact.name} />
          </Field>
          <Field label="Status" htmlFor="ce-status" hint="Subscribe someone again only when they asked">
            <Select id="ce-status" name="status" defaultValue={contact.status}>
              {["subscribed", "unconfirmed", "unsubscribed", "bounced", "complained"].map((s) => (
                <option key={s} value={s}>
                  {s[0]!.toUpperCase() + s.slice(1)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Fields" htmlFor="ce-fields" hint="One per line, as name: value; {{fields.name}} in an email">
          <textarea id="ce-fields" name="fields" rows={4} defaultValue={Object.entries(contact.fields).map(([k, v]) => `${k}: ${v}`).join("\n")} className="w-full border border-border bg-field px-2.5 py-2 font-mono text-[12.5px] outline-none focus:border-accent" spellCheck={false} />
        </Field>
        <div className="grid gap-1.5">
          <span className="text-[13px] font-bold">Lists</span>
          <ListChecks lists={lists} name="lists" checked={contact.lists} />
        </div>
        <Saved state={state} />
        <div>
          <SubmitButton pending="Saving…" className="w-auto">
            Save
          </SubmitButton>
        </div>
      </form>
      <form action={remove} onSubmit={(e) => !confirm(`Delete ${contact.email}? Their history goes too.`) && e.preventDefault()}>
        <Hidden values={{ brand: brandId, id: contact.id }} />
        <SubmitButton pending="Deleting…" variant="secondary" size="sm" className="w-auto border-rose/60 text-rose hover:bg-rose/10">
          Delete contact
        </SubmitButton>
      </form>
    </div>
  );
}

export function SuppressForm({ brandId }: { brandId: number }) {
  const [state, run] = useActionState(A.suppress, initial);
  return (
    <form action={run} className="grid gap-2">
      <Hidden values={{ brand: brandId }} />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Never email" htmlFor="s-email">
          <Input id="s-email" name="email" type="email" required spellCheck={false} className="sm:w-[260px]" />
        </Field>
        <SubmitButton pending="Adding…" variant="secondary" className="w-auto">
          Add
        </SubmitButton>
      </div>
      <Saved state={state} />
    </form>
  );
}

export function UnsuppressButton({ brandId, email }: { brandId: number; email: string }) {
  const [, run] = useActionState(A.unsuppress, initial);
  return (
    <form action={run} onSubmit={(e) => !confirm(`Allow email to ${email} again? Do it only if the address works and they want your emails.`) && e.preventDefault()}>
      <Hidden values={{ brand: brandId, email }} />
      <button type="submit" className="text-[12px] text-accent hover:underline">
        Remove
      </button>
    </form>
  );
}

// The editor

/** The email as a sample contact would see it: merge tags filled in, no tracking. */
function preview(format: "markdown" | "html", source: string, brand: { name: string; address: string }): string {
  const html = format === "markdown" ? markdownEmail(source || "*Write your email in Markdown on the left.*", { brand: brand.name, address: brand.address }) : source;
  return sampleMerge(html, brand.name);
}

export function ContentEditor({ format: initialFormat, source: initialSource, brand, prefix = "" }: { format: "markdown" | "html"; source: string; brand: { name: string; address: string }; prefix?: string }) {
  const [format, setFormat] = useState(initialFormat);
  const [source, setSource] = useState(initialSource);
  const doc = useMemo(() => preview(format, source, brand), [format, source, brand]);
  return (
    <div className="grid gap-2">
      <input type="hidden" name={`${prefix}format`} value={format} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex gap-0.5 border border-border bg-field p-[3px]" role="radiogroup" aria-label="Written in">
          {(["markdown", "html"] as const).map((f) => (
            <button key={f} type="button" role="radio" aria-checked={format === f} onClick={() => setFormat(f)} className={cx("px-[13px] py-[5px] transition-colors", format === f ? "bg-raised text-foreground shadow-raise" : "text-muted hover:text-foreground")}>
              {f === "markdown" ? "Markdown" : "HTML"}
            </button>
          ))}
        </div>
        <span className="text-[12px] text-muted">
          {"{{first_name}}"}, {"{{name}}"}, {"{{email}}"}, {"{{fields.plan}}"}; {"{{first_name|there}}"} for a fallback
        </span>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <textarea
          name={`${prefix}source`}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          rows={22}
          spellCheck={format === "markdown"}
          placeholder={format === "markdown" ? "# Hello {{first_name|there}}\n\nWhat's new this month…\n\n[[Read more](https://example.com)]" : "<!doctype html>…"}
          className="min-h-[420px] w-full resize-y border border-border bg-field px-3 py-2.5 font-mono text-[12.5px] leading-relaxed outline-none focus:border-accent"
          data-testid="editor-source"
        />
        <iframe title="Preview" sandbox="" srcDoc={doc} className="min-h-[420px] w-full border border-border bg-white" />
      </div>
      {format === "markdown" && <p className="text-[12px] text-muted">**bold**, *italic*, [link](https://…), ![image](https://…), - lists, &gt; quotes, --- a line, and [[Button](https://…)] on a line of its own. The footer with your address and the unsubscribe link is added.</p>}
    </div>
  );
}

// Campaigns

export function NewCampaignButton({ brandId, lists }: { brandId: number; lists: List[] }) {
  const [open, setOpen] = useState(false);
  const [state, run] = useActionState(A.newCampaign, initial);
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="new-campaign">
        <Icon icon={PlusIcon} size={16} /> New campaign
      </Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title="New campaign" description="A draft: write it, test it, then send">
          <form action={run} className="grid gap-4 px-[18px] py-5" data-testid="campaign-new">
            <Hidden values={{ brand: brandId }} />
            <Field label="Name" htmlFor="cn-name" hint="For you; recipients see the subject">
              <Input id="cn-name" name="name" required autoFocus placeholder="October update" />
            </Field>
            <div className="grid gap-1.5">
              <span className="text-[13px] font-bold">To</span>
              <ListChecks lists={lists} name="lists" none="No lists yet: add one on Lists." />
            </div>
            <FormError message={state.error} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton pending="Creating…" className="w-auto">
                Create draft
              </SubmitButton>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

export function CampaignEditor({ brand, campaign, lists, audience }: { brand: Brand; campaign: Campaign; lists: List[]; audience: number }) {
  const [state, run] = useActionState(A.saveCampaign, initial);
  const [confirming, setConfirming] = useState(false);
  const scheduled = campaign.status === "scheduled";
  return (
    <form action={run} className="grid gap-3.5" data-testid="campaign-editor">
      <Hidden values={{ brand: brand.id, id: campaign.id }} />
      <section className="grid gap-3 border border-border bg-card p-3.5">
        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="Subject" htmlFor="ce-subject">
            <Input id="ce-subject" name="subject" defaultValue={campaign.subject} placeholder="What's new in October" />
          </Field>
          <Field label="Preview text" htmlFor="ce-pre" hint="The line inboxes show after the subject">
            <Input id="ce-pre" name="preheader" defaultValue={campaign.preheader} />
          </Field>
          <Field label="From name" htmlFor="ce-fromname">
            <Input id="ce-fromname" name="fromName" defaultValue={campaign.fromName} />
          </Field>
          <Field label="From address" htmlFor="ce-from">
            <Input id="ce-from" name="fromEmail" type="email" defaultValue={campaign.fromEmail} spellCheck={false} />
          </Field>
          <Field label="Reply-to" htmlFor="ce-reply">
            <Input id="ce-reply" name="replyTo" type="email" defaultValue={campaign.replyTo} spellCheck={false} />
          </Field>
          <Field label="Name" htmlFor="ce-name" hint="For you">
            <Input id="ce-name" name="name" required defaultValue={campaign.name} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid content-start gap-1.5">
            <span className="text-[13px] font-bold">To</span>
            <ListChecks lists={lists} name="lists" checked={campaign.lists} />
          </div>
          <div className="grid content-start gap-1.5">
            <span className="text-[13px] font-bold">Leave out</span>
            <ListChecks lists={lists} name="excludeLists" checked={campaign.excludeLists} />
          </div>
        </div>
      </section>
      <ContentEditor format={campaign.format} source={campaign.source || campaign.html} brand={brand} />
      <section className="flex flex-wrap items-end gap-2 border border-border bg-card p-3.5">
        <SubmitButton pending="Saving…" variant="secondary" className="w-auto">
          Save draft
        </SubmitButton>
        <span className="mx-1 hidden h-6 w-px bg-border sm:block" />
        <Field label="Test to" htmlFor="ce-test">
          <Input id="ce-test" name="testTo" type="email" placeholder="you@example.com" className="sm:w-[220px]" />
        </Field>
        <Button type="submit" name="intent" value="test" variant="secondary">
          Save and send test
        </Button>
        <span className="flex-1" />
        <Field label="Send at (your time)" htmlFor="ce-at">
          <Input id="ce-at" name="at" type="datetime-local" defaultValue={campaign.scheduledAt ? new Date(campaign.scheduledAt - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ""} />
        </Field>
        <Button type="submit" name="intent" value="schedule" variant="secondary">
          {scheduled ? "Reschedule" : "Schedule"}
        </Button>
        <Button type="button" onClick={() => setConfirming(true)} data-testid="send-now">
          Send now…
        </Button>
      </section>
      <Saved state={state} />
      {confirming && (
        <Modal open onClose={() => setConfirming(false)} title="Send it now?" description={`To ${audience.toLocaleString("en")} subscribed contact${audience === 1 ? "" : "s"}, at ${brand.rate} a second`}>
          <div className="grid gap-4 px-[18px] py-5">
            <p className="text-[13px] text-muted">The draft is saved first. You can pause or cancel it while it sends.</p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button type="submit" name="intent" value="send" data-testid="send-confirm">
                Send to {audience.toLocaleString("en")}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </form>
  );
}

export function CampaignButtons({ brandId, campaign }: { brandId: number; campaign: Campaign }) {
  const [state, run] = useActionState(A.campaignAction, initial);
  const actions: [string, string][] = [];
  if (campaign.status === "sending") actions.push(["pause", "Pause"]);
  if (campaign.status === "paused") actions.push(["resume", "Resume"]);
  if (campaign.status === "scheduled") actions.push(["unschedule", "Back to draft"]);
  if (["scheduled", "sending", "paused"].includes(campaign.status)) actions.push(["cancel", "Cancel"]);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {actions.map(([action, label]) => (
        <form key={action} action={run} onSubmit={(e) => action === "cancel" && !confirm("Cancel it? What wasn't sent yet never will be.") && e.preventDefault()}>
          <Hidden values={{ brand: brandId, id: campaign.id, action }} />
          <SubmitButton pending="…" variant={action === "cancel" ? "secondary" : "primary"} size="sm" className="w-auto">
            {label}
          </SubmitButton>
        </form>
      ))}
      <MoreMenu label="More" buttonClassName="grid size-[26px] place-items-center border border-border text-muted hover:bg-hover hover:text-foreground">
        {() => (
          <>
            <form action={run}>
              <Hidden values={{ brand: brandId, id: campaign.id, action: "duplicate" }} />
              <button type="submit" role="menuitem" className={MENU_ITEM}>
                Duplicate
              </button>
            </form>
            {!["sending", "paused"].includes(campaign.status) && (
              <form action={run} onSubmit={(e) => !confirm(`Delete ${campaign.name}, and its report?`) && e.preventDefault()}>
                <Hidden values={{ brand: brandId, id: campaign.id, action: "delete" }} />
                <button type="submit" role="menuitem" className={cx(MENU_ITEM, "text-rose")}>
                  Delete
                </button>
              </form>
            )}
          </>
        )}
      </MoreMenu>
      {state.error && <p className="w-full text-[12px] text-rose">{state.error}</p>}
    </div>
  );
}

// Templates

export function TemplateEditor({ brand, template }: { brand: Brand; template?: Template }) {
  const [state, run] = useActionState(A.saveTemplate, initial);
  const [, remove] = useActionState(A.removeTemplate, initial);
  return (
    <div className="grid gap-3.5">
      <form action={run} className="grid gap-3.5" data-testid="template-editor">
        <Hidden values={{ brand: brand.id, id: template?.id ?? 0 }} />
        <section className="grid gap-3 border border-border bg-card p-3.5 lg:grid-cols-2">
          <Field label="Name" htmlFor="te-name">
            <Input id="te-name" name="name" required defaultValue={template?.name} placeholder="Password reset" />
          </Field>
          <Field label="Subject" htmlFor="te-subject" hint="{{variables}} work here too">
            <Input id="te-subject" name="subject" defaultValue={template?.subject} placeholder="Reset your password" />
          </Field>
        </section>
        <ContentEditor format={template?.format ?? "markdown"} source={template?.source || template?.html || ""} brand={brand} />
        <Saved state={state} />
        <div>
          <SubmitButton pending="Saving…" className="w-auto">
            {template ? "Save" : "Add template"}
          </SubmitButton>
        </div>
      </form>
      {template && (
        <form action={remove} onSubmit={(e) => !confirm(`Delete the template ${template.name}? Emails sent with it stay in the logs.`) && e.preventDefault()}>
          <Hidden values={{ brand: brand.id, id: template.id }} />
          <SubmitButton pending="Deleting…" variant="secondary" size="sm" className="w-auto border-rose/60 text-rose hover:bg-rose/10">
            Delete template
          </SubmitButton>
        </form>
      )}
    </div>
  );
}

// Automations

function TriggerFields({ lists, trigger, value }: { lists: List[]; trigger: "list" | "event"; value: string }) {
  const [kind, setKind] = useState(trigger);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Starts when" htmlFor="a-trigger">
        <Select id="a-trigger" name="trigger" value={kind} onChange={(e) => setKind(e.target.value as "list" | "event")}>
          <option value="list">A contact joins a list</option>
          <option value="event">The API sends an event</option>
        </Select>
      </Field>
      {kind === "list" ? (
        <Field label="List" htmlFor="a-list">
          <Select id="a-list" name="list" defaultValue={value}>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <Field label="Event" htmlFor="a-event" hint="POST /events with this name">
          <Input id="a-event" name="event" defaultValue={value} placeholder="signed_up" spellCheck={false} />
        </Field>
      )}
    </div>
  );
}

export function NewAutomationButton({ brandId, lists }: { brandId: number; lists: List[] }) {
  const [open, setOpen] = useState(false);
  const [state, run] = useActionState(A.newAutomation, initial);
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="new-automation">
        <Icon icon={PlusIcon} size={16} /> New automation
      </Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title="New automation" description="A trigger, then steps">
          <form action={run} className="grid gap-4 px-[18px] py-5" data-testid="automation-new">
            <Hidden values={{ brand: brandId }} />
            <Field label="Name" htmlFor="an-name">
              <Input id="an-name" name="name" required autoFocus placeholder="Welcome series" />
            </Field>
            <TriggerFields lists={lists} trigger={lists.length ? "list" : "event"} value={String(lists[0]?.id ?? "")} />
            <FormError message={state.error} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton pending="Creating…" className="w-auto">
                Create
              </SubmitButton>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

const newEmailStep = (): Step => ({ type: "email", subject: "", preheader: "", html: "", text: "", source: "", format: "markdown", fromName: "", fromEmail: "" });

/** Waits shown as days, hours or minutes. */
function waitParts(minutes: number): { n: number; unit: "minutes" | "hours" | "days" } {
  if (minutes % 1440 === 0) return { n: minutes / 1440, unit: "days" };
  if (minutes % 60 === 0) return { n: minutes / 60, unit: "hours" };
  return { n: minutes, unit: "minutes" };
}

export function AutomationEditor({ brand, automation, lists }: { brand: Brand; automation: Automation; lists: List[] }) {
  const [state, run] = useActionState(A.saveAutomation, initial);
  const [steps, setSteps] = useState<Step[]>(automation.steps);
  const [open, setOpen] = useState<number | null>(null);
  const set = (i: number, s: Step) => setSteps(steps.map((x, j) => (j === i ? s : x)));
  const move = (i: number, d: number) => {
    const next = [...steps];
    const [s] = next.splice(i, 1);
    next.splice(i + d, 0, s!);
    setSteps(next);
  };
  return (
    <form action={run} className="grid gap-3.5" data-testid="automation-editor">
      <Hidden values={{ brand: brand.id, id: automation.id }} />
      <input type="hidden" name="steps" value={JSON.stringify(steps)} />
      <section className="grid gap-3 border border-border bg-card p-3.5">
        <Field label="Name" htmlFor="ae-name">
          <Input id="ae-name" name="name" required defaultValue={automation.name} />
        </Field>
        <TriggerFields lists={lists} trigger={automation.trigger} value={automation.triggerValue} />
      </section>
      <section className="border border-border bg-card">
        <div className="flex items-center justify-between px-3.5 pb-2.5 pt-3.5">
          <h2 className="text-[14px] font-bold">Steps</h2>
          <span className="text-[12px] text-muted">One after another; a run stops at a wait and goes on when it's due</span>
        </div>
        {steps.length === 0 && <p className="border-t border-border px-3.5 py-6 text-center text-muted">No steps yet: add the first below.</p>}
        {steps.map((s, i) => (
          <div key={i} className="border-t border-border px-3.5 py-3" data-testid="automation-step">
            <div className="flex flex-wrap items-center gap-2">
              <span className="grid size-6 place-items-center bg-well text-[12px] font-bold tabular-nums">{i + 1}</span>
              {s.type === "wait" ? (
                (() => {
                  const w = waitParts(s.minutes);
                  const mult = { minutes: 1, hours: 60, days: 1440 };
                  return (
                    <span className="flex items-center gap-2 text-[13px]">
                      Wait
                      <Input type="number" min={1} value={w.n} onChange={(e) => set(i, { type: "wait", minutes: Math.max(1, Number(e.target.value) || 1) * mult[w.unit] })} className="h-[31px] w-[80px] tabular-nums" />
                      <Select value={w.unit} onChange={(e) => set(i, { type: "wait", minutes: w.n * mult[e.target.value as keyof typeof mult] })} className="h-[31px] w-[110px]">
                        <option value="minutes">minutes</option>
                        <option value="hours">hours</option>
                        <option value="days">days</option>
                      </Select>
                    </span>
                  );
                })()
              ) : s.type === "email" ? (
                <button type="button" onClick={() => setOpen(open === i ? null : i)} className="min-w-0 flex-1 truncate text-left text-[13px] hover:underline">
                  Send <b className="font-bold">{s.subject || "an email (no subject yet)"}</b>
                </button>
              ) : (
                <span className="flex items-center gap-2 whitespace-nowrap text-[13px]">
                  {s.type === "add_to_list" ? "Add to" : "Remove from"}
                  <Select value={s.listId} onChange={(e) => set(i, { ...s, listId: Number(e.target.value) })} className="h-[31px] w-[200px]">
                    {lists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </Select>
                </span>
              )}
              <span className="ml-auto flex items-center gap-1">
                <button type="button" aria-label="Up" disabled={i === 0} onClick={() => move(i, -1)} className="grid size-7 place-items-center text-muted hover:bg-hover disabled:opacity-30">
                  <Icon icon={ArrowUpIcon} size={14} />
                </button>
                <button type="button" aria-label="Down" disabled={i === steps.length - 1} onClick={() => move(i, 1)} className="grid size-7 place-items-center text-muted hover:bg-hover disabled:opacity-30">
                  <Icon icon={ArrowDownIcon} size={14} />
                </button>
                <button type="button" aria-label="Remove" onClick={() => setSteps(steps.filter((_, j) => j !== i))} className="grid size-7 place-items-center text-muted hover:bg-hover hover:text-rose">
                  <Icon icon={TrashIcon} size={14} />
                </button>
              </span>
            </div>
            {s.type === "email" && open === i && (
              <div className="mt-3 grid gap-3">
                <div className="grid gap-3 lg:grid-cols-2">
                  <Field label="Subject" htmlFor={`s${i}-subject`}>
                    <Input id={`s${i}-subject`} value={s.subject} onChange={(e) => set(i, { ...s, subject: e.target.value })} />
                  </Field>
                  <Field label="Preview text" htmlFor={`s${i}-pre`}>
                    <Input id={`s${i}-pre`} value={s.preheader} onChange={(e) => set(i, { ...s, preheader: e.target.value })} />
                  </Field>
                </div>
                <StepContent step={s} brand={brand} onChange={(next) => set(i, next)} />
              </div>
            )}
          </div>
        ))}
        <div className="flex flex-wrap gap-2 border-t border-border px-3.5 py-3">
          <Button type="button" variant="secondary" size="sm" onClick={() => (setSteps([...steps, newEmailStep()]), setOpen(steps.length))}>
            <Icon icon={PlusIcon} size={13} /> Email
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => setSteps([...steps, { type: "wait", minutes: 1440 }])}>
            <Icon icon={PlusIcon} size={13} /> Wait
          </Button>
          {lists.length > 0 && (
            <>
              <Button type="button" variant="secondary" size="sm" onClick={() => setSteps([...steps, { type: "add_to_list", listId: lists[0]!.id }])}>
                <Icon icon={PlusIcon} size={13} /> Add to a list
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => setSteps([...steps, { type: "remove_from_list", listId: lists[0]!.id }])}>
                <Icon icon={PlusIcon} size={13} /> Remove from a list
              </Button>
            </>
          )}
        </div>
      </section>
      <Saved state={state} />
      <div>
        <SubmitButton pending="Saving…" className="w-auto">
          Save
        </SubmitButton>
      </div>
    </form>
  );
}

/** An email step's content: the editor, kept in the step (not the form). */
function StepContent({ step, brand, onChange }: { step: Extract<Step, { type: "email" }>; brand: Brand; onChange: (s: Step) => void }) {
  const doc = useMemo(() => preview(step.format, step.source, brand), [step.format, step.source, brand]);
  return (
    <div className="grid gap-2">
      <div className="inline-flex gap-0.5 self-start justify-self-start border border-border bg-field p-[3px]">
        {(["markdown", "html"] as const).map((f) => (
          <button key={f} type="button" onClick={() => onChange({ ...step, format: f })} className={cx("px-[13px] py-[5px]", step.format === f ? "bg-raised text-foreground shadow-raise" : "text-muted hover:text-foreground")}>
            {f === "markdown" ? "Markdown" : "HTML"}
          </button>
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <textarea value={step.source} onChange={(e) => onChange({ ...step, source: e.target.value })} rows={14} className="min-h-[300px] w-full resize-y border border-border bg-field px-3 py-2.5 font-mono text-[12.5px] leading-relaxed outline-none focus:border-accent" placeholder="Hi {{first_name|there}}, …" />
        <iframe title="Preview" sandbox="" srcDoc={doc} className="min-h-[300px] w-full border border-border bg-white" />
      </div>
    </div>
  );
}

export function AutomationButtons({ brandId, automation }: { brandId: number; automation: Automation }) {
  const [state, run] = useActionState(A.setAutomationStatus, initial);
  const [, remove] = useActionState(A.removeAutomation, initial);
  const active = automation.status === "active";
  return (
    <div className="grid justify-items-end gap-1">
      <div className="flex items-center gap-1.5">
        <form action={run}>
          <Hidden values={{ brand: brandId, id: automation.id, status: active ? "paused" : "active" }} />
          <SubmitButton pending="…" variant={active ? "secondary" : "primary"} className="w-auto">
            {active ? "Pause" : "Turn on"}
          </SubmitButton>
        </form>
        <MoreMenu label="More" buttonClassName="grid size-[35px] place-items-center border border-border text-muted hover:bg-hover hover:text-foreground">
          {() => (
            <form action={remove} onSubmit={(e) => !confirm(`Delete ${automation.name}? Runs in progress stop.`) && e.preventDefault()}>
              <Hidden values={{ brand: brandId, id: automation.id }} />
              <button type="submit" role="menuitem" className={cx(MENU_ITEM, "text-rose")}>
                Delete
              </button>
            </form>
          )}
        </MoreMenu>
      </div>
      {state.error && <p className="max-w-[360px] text-right text-[12px] text-rose">{state.error}</p>}
    </div>
  );
}

// API keys

export function CreateKeyForm({ brandId }: { brandId: number }) {
  const [state, run] = useActionState(A.createKey, initial);
  return (
    <div className="grid gap-3">
      <form action={run} className="flex flex-wrap items-end gap-2" data-testid="create-key">
        <Hidden values={{ brand: brandId }} />
        <Field label="Name" htmlFor="k-name" hint="Where it's used">
          <Input id="k-name" name="name" required placeholder="Production app" className="sm:w-[260px]" />
        </Field>
        <SubmitButton pending="Creating…" className="w-auto">
          Create key
        </SubmitButton>
      </form>
      <FormError message={state.error} />
      {state.value && (
        <div className="grid gap-1.5" data-testid="new-key">
          <span className="text-[13px] font-bold text-teal">Copy it now: it won&apos;t be shown again.</span>
          <div className="flex items-start gap-2 bg-well px-3 py-2.5">
            <code className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{state.value}</code>
            <CopyButton text={state.value} />
          </div>
        </div>
      )}
    </div>
  );
}

export function RevokeKeyButton({ brandId, id, name }: { brandId: number; id: number; name: string }) {
  const [, run] = useActionState(A.revokeKey, initial);
  return (
    <form action={run} onSubmit={(e) => !confirm(`Revoke ${name}? Apps using it stop sending.`) && e.preventDefault()}>
      <Hidden values={{ brand: brandId, id }} />
      <button type="submit" className="text-[12px] text-rose hover:underline">
        Revoke
      </button>
    </form>
  );
}

export function EmailSettingsForm({ keepBodiesDays, keepDays }: { keepBodiesDays: number; keepDays: number }) {
  const [state, run] = useActionState(A.saveEmailSettings, initial);
  return (
    <form action={run} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Keep email bodies for (days)" htmlFor="es-bodies" hint="What transactional and automation emails said, for the logs">
          <Input id="es-bodies" name="keepBodiesDays" type="number" min={1} max={365} defaultValue={keepBodiesDays} className="max-w-[160px] tabular-nums" />
        </Field>
        <Field label="Keep logs for (days)" htmlFor="es-keep" hint="Who got what, when, and what happened">
          <Input id="es-keep" name="keepDays" type="number" min={1} max={3650} defaultValue={keepDays} className="max-w-[160px] tabular-nums" />
        </Field>
      </div>
      <Saved state={state} />
      <div>
        <SubmitButton pending="Saving…" className="w-auto">
          Save
        </SubmitButton>
      </div>
    </form>
  );
}

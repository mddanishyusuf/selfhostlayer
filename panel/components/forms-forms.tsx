"use client";

// Forms' forms: a new form from a template, a form's settings (its address and
// when it stops taking answers), who's told about responses (emails through
// the Email integration, a signed webhook), sharing (the link, a QR code,
// embed codes), and deleting responses and forms.
import { CopyIcon, DownloadIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useActionState, useEffect, useState } from "react";
import { renderSVG } from "uqr";
import * as A from "@/app/actions/forms";
import { TEMPLATES } from "@/lib/form-templates";
import type { Form } from "@/lib/forms";
import { CopyButton, SubmitButton } from "./form";
import { Icon } from "./icon";
import { Modal } from "./modal";
import { Button, Field, FormError, Group, Input, SecretInput, Select, cx } from "./ui";

const initial: A.FormState = {};

function Saved({ state }: { state: A.FormState }) {
  return (
    <>
      <FormError message={state.error} />
      {state.saved && <p className="text-[13px] text-teal">{state.saved}</p>}
    </>
  );
}

/** The value a datetime-local field shows for a moment, in the browser's own time zone. */
const localInput = (ms: number | null) => {
  if (!ms) return "";
  const d = new Date(ms);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// New forms

export function NewFormDialog({ onClose }: { onClose: () => void }) {
  const [state, run] = useActionState(A.newForm, initial);
  const [template, setTemplate] = useState(TEMPLATES[0]!.id);
  return (
    <Modal open onClose={onClose} title="New form" description="Start from a template: every question in it can change">
      <form action={run} className="grid gap-4 px-[18px] py-5" data-testid="new-form">
        <Field label="Title" htmlFor="nf-title" hint="At the top of the form">
          <Input id="nf-title" name="title" autoFocus placeholder={template === "blank" ? "Untitled form" : TEMPLATES.find((t) => t.id === template)!.name} />
        </Field>
        <input type="hidden" name="template" value={template} />
        <Group label="Start from">
          {/* Blank across the top, the four templates two by two under it. */}
          <div className="grid gap-1.5 sm:grid-cols-2" role="radiogroup" aria-label="Start from">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={template === t.id}
                onClick={() => setTemplate(t.id)}
                className={cx("grid content-start gap-0.5 border px-3 py-2.5 text-left transition-colors duration-150", t.id === "blank" && "sm:col-span-2", template === t.id ? "border-accent bg-selected" : "border-border hover:bg-hover")}
                data-testid={`template-${t.id}`}
              >
                <b className="text-[13px]">{t.name}</b>
                <span className="text-[12px] text-muted">{t.description}</span>
              </button>
            ))}
          </div>
        </Group>
        <FormError message={state.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <SubmitButton pending="Creating…" className="w-auto">
            Create form
          </SubmitButton>
        </div>
      </form>
    </Modal>
  );
}

export function NewFormButton({ size = "md" }: { size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} onClick={() => setOpen(true)} data-testid="new-form-button">
        <Icon icon={PlusIcon} size={size === "sm" ? 13 : 16} /> New form
      </Button>
      {open && <NewFormDialog onClose={() => setOpen(false)} />}
    </>
  );
}

// A form's settings

export function FormSettingsForm({ form, publicUrl }: { form: Form; publicUrl: string }) {
  const [state, run] = useActionState(A.saveFormSettings, initial);
  const [closeAt, setCloseAt] = useState("");
  // The browser's time zone, so only after the first render.
  useEffect(() => setCloseAt(localInput(form.closeAt)), [form.closeAt]);
  return (
    <form action={run} className="grid gap-3" data-testid="form-settings">
      <input type="hidden" name="id" value={form.id} />
      <input type="hidden" name="closeAt" value={closeAt ? String(new Date(closeAt).getTime()) : ""} />
      <Field label="Address" htmlFor="fs-slug" hint="Changing it breaks the old link and embeds">
        <div className="flex items-center border border-border bg-field focus-within:border-accent">
          <span className="truncate pl-2.5 text-[13px] text-muted">{publicUrl.replace(/^https?:\/\//, "")}/f/</span>
          <input id="fs-slug" name="slug" defaultValue={form.slug} required pattern="[a-z0-9](?:[a-z0-9\-]{0,48}[a-z0-9])?" title="Small letters, digits and dashes" spellCheck={false} autoComplete="off" className="h-[37px] min-w-0 flex-1 bg-transparent pr-2.5 outline-none" />
        </div>
      </Field>
      <label className="flex items-center gap-2.5 text-[13px]">
        <input type="checkbox" name="open" defaultChecked={form.status === "open"} className="size-4 accent-accent" data-testid="form-open" /> Taking answers
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Close at" htmlFor="fs-close" hint="Your time zone; empty for never">
          <Input id="fs-close" type="datetime-local" value={closeAt} onChange={(e) => setCloseAt(e.target.value)} />
        </Field>
        <Field label="Close after" htmlFor="fs-max" hint="Responses; empty for no limit">
          <Input id="fs-max" name="maxResponses" type="number" min={1} defaultValue={form.maxResponses ?? ""} />
        </Field>
      </div>
      <Field label="When it's closed" htmlFor="fs-msg" hint="What people see instead of the form">
        <textarea id="fs-msg" name="closedMessage" rows={2} defaultValue={form.closedMessage} placeholder="This form isn't taking answers any more." className="w-full border border-border bg-field px-2.5 py-2 outline-none focus:border-accent" />
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

/** Who's told: the owner by email, the respondent's copy, and a webhook. */
export function NotifyForm({ form, emailReady, emailFields }: { form: Form; emailReady: boolean; emailFields: { id: string; label: string }[] }) {
  const [state, run] = useActionState(A.saveNotify, initial);
  const [testState, test] = useActionState(A.testWebhook, initial);
  return (
    <div className="grid gap-3">
      <form action={run} className="grid gap-3" data-testid="notify-form">
        <input type="hidden" name="id" value={form.id} />
        <Field label="Email me at" htmlFor="nt-email" hint={emailReady ? "Every response, with its answers; replies go to the respondent" : "Connect Email below first"}>
          <Input id="nt-email" name="email" type="email" defaultValue={form.notify.email} disabled={!emailReady} placeholder="you@example.com" spellCheck={false} />
        </Field>
        <Field label="Send respondents a copy" htmlFor="nt-receipt" hint={emailFields.length ? "To the address they gave" : "The form needs an Email question for this"}>
          <Select id="nt-receipt" name="receiptField" defaultValue={form.notify.receiptField} disabled={!emailReady || !emailFields.length}>
            <option value="">No copy</option>
            {emailFields.map((f) => (
              <option key={f.id} value={f.id}>
                To the answer to “{f.label || f.id}”
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Webhook" htmlFor="nt-hook" hint="Each response is posted here as JSON, signed in X-Forms-Signature">
          <Input id="nt-hook" name="webhook" type="url" defaultValue={form.notify.webhook} placeholder="https://example.com/hooks/forms" spellCheck={false} />
        </Field>
        {form.notify.webhookSecret && (
          <Field label="Signing secret" htmlFor="nt-secret" hint="sha256=HMAC of the body with this secret">
            <div className="flex items-center gap-2">
              <SecretInput id="nt-secret" readOnly value={form.notify.webhookSecret} className="font-mono text-[12.5px]" />
              <CopyButton text={form.notify.webhookSecret} />
            </div>
          </Field>
        )}
        {form.notify.webhookSecret && (
          <label className="flex items-center gap-2.5 text-[13px]">
            <input type="checkbox" name="newSecret" className="size-4 accent-accent" /> Make a new secret (the old one stops working)
          </label>
        )}
        <Saved state={state} />
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending="Saving…" className="w-auto">
            Save
          </SubmitButton>
        </div>
      </form>
      {form.notify.webhook && (
        <form action={test} className="grid gap-2">
          <input type="hidden" name="id" value={form.id} />
          <div>
            <SubmitButton pending="Sending…" variant="secondary" size="sm" className="w-auto">
              Send a test to the webhook
            </SubmitButton>
          </div>
          <Saved state={testState} />
        </form>
      )}
    </div>
  );
}

/** Forms sends its emails through Email: a brand's key and From address. */
export function EmailConnect({ connected, emailInstalled, brands }: { connected: { from: string; brand: string; keyHint: string } | null; emailInstalled: boolean; brands: { id: number; name: string; from: string }[] }) {
  const [state, run] = useActionState(A.connectEmail, initial);
  const [offState, disconnect] = useActionState(A.disconnectEmail, initial);
  if (connected) {
    return (
      <form action={disconnect} className="grid gap-2" data-testid="email-connected">
        <p className="text-[13px]">
          Sending as <b>{connected.from}</b> through {connected.brand || "Email"} <span className="font-mono text-[12px] text-dim">{connected.keyHint}…</span>
        </p>
        <Saved state={offState} />
        <div>
          <SubmitButton pending="Disconnecting…" variant="secondary" size="sm" className="w-auto">
            Disconnect
          </SubmitButton>
        </div>
      </form>
    );
  }
  if (!emailInstalled) return <p className="text-[13px] text-muted">Install Email from Integrations: Forms sends its emails through it, with your SMTP or Amazon SES.</p>;
  if (!brands.length) return <p className="text-[13px] text-muted">Add a brand in Email first, with a From address on a verified domain.</p>;
  return (
    <form action={run} className="grid gap-2" data-testid="email-connect">
      <Field
        label="Brand"
        htmlFor="ec-brand"
        hint="Its From address and provider send the emails"
        action={
          <SubmitButton pending="Connecting…" className="w-auto">
            Connect
          </SubmitButton>
        }
      >
        <Select id="ec-brand" name="brand">
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
              {b.from ? ` · ${b.from}` : " · no From address"}
            </option>
          ))}
        </Select>
      </Field>
      <Saved state={state} />
    </form>
  );
}

export function DuplicateFormButton({ id }: { id: number }) {
  const [state, run] = useActionState(A.duplicateForm, initial);
  return (
    <form action={run} className="grid gap-2">
      <input type="hidden" name="id" value={id} />
      <div>
        <SubmitButton pending="Copying…" variant="secondary" size="sm" className="w-auto">
          <Icon icon={CopyIcon} size={13} /> Duplicate
        </SubmitButton>
      </div>
      <FormError message={state.error} />
    </form>
  );
}

export function DeleteFormButton({ form }: { form: Form }) {
  const [state, run] = useActionState(A.deleteForm, initial);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  return (
    <>
      <Button type="button" variant="secondary" size="sm" className="border-rose/60 text-rose hover:bg-rose/10" onClick={() => setOpen(true)} data-testid="delete-form">
        Delete the form…
      </Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title={`Delete ${form.title}`} description="This can't be undone">
          <form action={run} className="grid gap-4 px-[18px] py-5">
            <input type="hidden" name="id" value={form.id} />
            <input type="hidden" name="title" value={form.title} />
            <p className="text-[12px] text-muted">
              Its {form.responses.toLocaleString("en")} response{form.responses === 1 ? "" : "s"} and their files are deleted, and its link and embeds stop working.
            </p>
            <Field label={`Type ${form.title} to confirm`} htmlFor="df-confirm">
              <Input id="df-confirm" name="confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus spellCheck={false} />
            </Field>
            <FormError message={state.error} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="danger" disabled={typed !== form.title}>
                Delete form
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

// Responses

export function DeleteResponseButton({ formId, responseId }: { formId: number; responseId: number }) {
  const [state, run] = useActionState(A.deleteResponse, initial);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" size="sm" className="border-rose/60 text-rose hover:bg-rose/10" onClick={() => setOpen(true)} data-testid="delete-response">
        <Icon icon={TrashIcon} size={13} /> Delete
      </Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title="Delete this response" description="Its answers and files are deleted for good">
          <form action={run} className="grid gap-4 px-[18px] py-5">
            <input type="hidden" name="id" value={formId} />
            <input type="hidden" name="response" value={responseId} />
            <FormError message={state.error} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton pending="Deleting…" variant="danger" className="w-auto">
                Delete response
              </SubmitButton>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

export function DeleteAllResponses({ formId, count }: { formId: number; count: number }) {
  const [state, run] = useActionState(A.deleteAllResponses, initial);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (state.saved) setOpen(false);
  }, [state]);
  return (
    <>
      <Button type="button" variant="secondary" size="sm" className="border-rose/60 text-rose hover:bg-rose/10" onClick={() => setOpen(true)} disabled={!count}>
        Delete every response…
      </Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title="Delete every response" description="This can't be undone">
          <form action={run} className="grid gap-4 px-[18px] py-5">
            <input type="hidden" name="id" value={formId} />
            <p className="text-[12px] text-muted">
              All {count.toLocaleString("en")} response{count === 1 ? "" : "s"} and their files go. The form stays, with its views and starts counted so far.
            </p>
            <Field label="Type delete to confirm" htmlFor="da-confirm">
              <Input id="da-confirm" name="confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus spellCheck={false} />
            </Field>
            <FormError message={state.error} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="danger" disabled={typed !== "delete"}>
                Delete responses
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

// Sharing

/** A line of code or a link, with a copy button. */
export function CopyLine({ text, label = "Copy", testId }: { text: string; label?: string; testId?: string }) {
  // The button by the code's only line, or by its first.
  const lines = text.includes("\n");
  return (
    <div className={cx("flex min-w-0 gap-2", lines ? "items-start" : "items-center")}>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre border border-border bg-field px-2.5 py-2 font-mono text-[12.5px]" data-testid={testId}>
        {text}
      </code>
      <span className={lines ? "mt-[5px]" : undefined}>
        <CopyButton text={text} label={label} />
      </span>
    </div>
  );
}

/** The form's link as a QR code, to download as SVG or a 1024px PNG. */
export function QrCode({ url, name }: { url: string; name: string }) {
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
    <div className="flex flex-wrap items-center gap-4">
      {/* White behind the code in both themes: scanners need the contrast. */}
      <div className="size-[136px] bg-white p-1.5 [&_svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="grid gap-2">
        <Button variant="secondary" size="sm" onClick={() => download(`${name}.svg`, new Blob([svg], { type: "image/svg+xml" }))}>
          <Icon icon={DownloadIcon} size={13} /> SVG
        </Button>
        <Button variant="secondary" size="sm" onClick={png}>
          <Icon icon={DownloadIcon} size={13} /> PNG
        </Button>
      </div>
    </div>
  );
}

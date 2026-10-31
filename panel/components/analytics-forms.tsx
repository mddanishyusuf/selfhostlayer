"use client";

import { PlusIcon } from "lucide-react";
import { useActionState, useState } from "react";
import { addSite, removeSite, saveAnalyticsSettings, setSubdomains, type AnalyticsSettingsState, type SiteState } from "@/app/actions/analytics";
import { CopyButton, SubmitButton } from "./form";
import { Icon } from "./icon";
import { Modal } from "./modal";
import { SettingsRow } from "./page";
import { Button, Field, FormError, Input } from "./ui";

/** The fields of a new site; projects' domains one click away. */
function SiteFields({ suggestions }: { suggestions: string[] }) {
  const [state, action] = useActionState(addSite, {} as SiteState);
  return (
    <div className="grid gap-4">
      <form action={action} className="grid gap-3" data-testid="add-site">
        <Field label="Domain" htmlFor="domain" hint="Its pages send visits here, www. included">
          <Input id="domain" name="domain" required placeholder="example.com" spellCheck={false} autoFocus />
        </Field>
        <label className="flex items-center gap-2.5 text-[13px]">
          <input type="checkbox" name="subdomains" className="size-4 accent-accent" /> Count its subdomains too (blog.example.com)
        </label>
        <FormError message={state.error} />
        <div>
          <SubmitButton pending="Adding…" className="w-auto">
            Add site
          </SubmitButton>
        </div>
      </form>
      {suggestions.length > 0 && (
        <div className="grid gap-2 border-t border-border pt-3.5">
          <span className="text-[12px] text-muted">Or one of your projects:</span>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((domain) => (
              <form key={domain} action={action}>
                <input type="hidden" name="domain" value={domain} />
                <Button type="submit" variant="secondary" size="sm">
                  <Icon icon={PlusIcon} size={13} /> {domain}
                </Button>
              </form>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function AddSiteButton({ suggestions }: { suggestions: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="new-site">
        <Icon icon={PlusIcon} size={16} /> Add a site
      </Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title="Add a site" description="Then paste one line into its pages">
          <div className="px-[18px] py-5">
            <SiteFields suggestions={suggestions} />
          </div>
        </Modal>
      )}
    </>
  );
}

/** The first site, right on the page. */
export function FirstSite({ suggestions }: { suggestions: string[] }) {
  return (
    <div className="mx-auto w-full max-w-[520px] px-3.5 py-6">
      <SiteFields suggestions={suggestions} />
    </div>
  );
}

/** The line to paste into a site's pages, with Copy. */
export function Snippet({ code }: { code: string }) {
  return (
    <div className="flex items-start gap-2 bg-well px-3 py-2.5" data-testid="snippet">
      <code className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{code}</code>
      <CopyButton text={code} />
    </div>
  );
}

export function SubdomainsToggle({ id, on }: { id: number; on: boolean }) {
  const [state, action] = useActionState(setSubdomains, {} as SiteState);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2.5">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="subdomains" value={String(!on)} />
      <span className="text-[13px]">{on ? "Its subdomains count too." : "Only the domain itself (and www.) counts."}</span>
      <SubmitButton pending="Saving…" variant="secondary" size="sm" className="w-auto">
        {on ? "Leave subdomains out" : "Count subdomains too"}
      </SubmitButton>
      <FormError message={state.error} />
    </form>
  );
}

export function RemoveSite({ id, domain }: { id: number; domain: string }) {
  const [state, action] = useActionState(removeSite, {} as SiteState);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  return (
    <>
      <Button type="button" variant="secondary" size="sm" className="border-rose/60 text-rose hover:bg-rose/10" onClick={() => setOpen(true)}>
        Remove {domain}…
      </Button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title={`Remove ${domain}`} description="This can't be undone">
          <form action={action} className="grid gap-4 px-[18px] py-5">
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="domain" value={domain} />
            <p className="text-[12px] text-muted">Everything counted for it is deleted, and its pages' events are refused until you add it again.</p>
            <Field label={`Type ${domain} to confirm`} htmlFor="confirm">
              <Input id="confirm" name="confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus spellCheck={false} />
            </Field>
            <FormError message={state.error} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="danger" disabled={typed.toLowerCase() !== domain}>
                Remove site
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

/** Analytics' own settings, on its Settings page. */
export function AnalyticsSettingsForm({ keepDays }: { keepDays: number }) {
  const [state, action] = useActionState(saveAnalyticsSettings, {} as AnalyticsSettingsState);
  return (
    <form action={action}>
      <SettingsRow title="Analytics" description="Kept in Analytics and used by its daily clean-up.">
        <Field label="Keep visits for (days)" htmlFor="keepDays" hint="Older events and visits are deleted">
          <Input id="keepDays" name="keepDays" type="number" min={1} max={3650} defaultValue={keepDays} className="max-w-[160px] tabular-nums" />
        </Field>
      </SettingsRow>
      <div className="grid gap-3 border-b border-border px-3.5 py-5">
        <FormError message={state.error} />
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

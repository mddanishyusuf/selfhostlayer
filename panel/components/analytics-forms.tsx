"use client";

import { PlusIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import {
  addSite,
  deleteGoal,
  removeSite,
  removeSource,
  saveAnalyticsSettings,
  saveGoal,
  saveSource,
  setSubdomains,
  syncNow,
  type AnalyticsSettingsState,
  type GoalState,
  type SiteState,
  type SourceState,
  type SyncState,
} from "@/app/actions/analytics";
import type { Provider } from "@/lib/analytics";
import { CopyButton, SubmitButton } from "./form";
import { Icon } from "./icon";
import { MENU_ITEM, MoreMenu } from "./menu";
import { Modal } from "./modal";
import { SettingsRow } from "./page";
import { Button, Field, FormError, Input, SecretInput, Select } from "./ui";

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

export function AddSiteDialog({ suggestions, onClose }: { suggestions: string[]; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Add a site" description="Then paste one line into its pages">
      <div className="px-[18px] py-5">
        <SiteFields suggestions={suggestions} />
      </div>
    </Modal>
  );
}

export function AddSiteButton({ suggestions }: { suggestions: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="add-site-button">
        <Icon icon={PlusIcon} size={16} /> Add a site
      </Button>
      {open && <AddSiteDialog suggestions={suggestions} onClose={() => setOpen(false)} />}
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

/** A goal: a page (with * for any characters) or an event. New, or changing one. */
function GoalDialog({ site, goal, onClose }: { site: number; goal?: { id: number; name: string; kind: "page" | "event"; value: string }; onClose: () => void }) {
  const [state, action] = useActionState(saveGoal, {} as GoalState);
  const [kind, setKind] = useState<"page" | "event">(goal?.kind ?? "page");
  useEffect(() => {
    if (state.done) onClose();
  }, [state, onClose]);
  return (
    <Modal open onClose={onClose} title={goal ? `Change ${goal.name}` : "New goal"} description="Visitors who reach it count as converted">
      <form action={action} className="grid gap-4 px-[18px] py-5" data-testid="goal-form">
        <input type="hidden" name="site" value={site} />
        {goal && <input type="hidden" name="id" value={goal.id} />}
        <Field label="When a visitor" htmlFor="kind">
          <Select id="kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value as "page" | "event")}>
            <option value="page">Visits a page</option>
            <option value="event">Sends an event</option>
          </Select>
        </Field>
        <Field label={kind === "page" ? "Page" : "Event"} htmlFor="value" hint={kind === "page" ? "A path; * matches anything, as in /blog/*" : "The name given to window.shl.track"}>
          <Input id="value" name="value" required defaultValue={goal?.value} placeholder={kind === "page" ? "/thank-you" : "Signup"} spellCheck={false} autoFocus />
        </Field>
        <Field label="Name" htmlFor="name" hint="Optional; the page or event otherwise">
          <Input id="name" name="name" defaultValue={goal?.name} placeholder={kind === "page" ? "Bought" : "Signed up"} />
        </Field>
        <FormError message={state.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <SubmitButton pending="Saving…" className="w-auto">
            {goal ? "Save" : "Add goal"}
          </SubmitButton>
        </div>
      </form>
    </Modal>
  );
}

export function NewGoalButton({ site }: { site: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="new-goal">
        <Icon icon={PlusIcon} size={16} /> New goal
      </Button>
      {open && <GoalDialog site={site} onClose={() => setOpen(false)} />}
    </>
  );
}

/** A goal's … menu: its visits, change it, delete it. */
export function GoalActions({ site, domain, goal }: { site: number; domain: string; goal: { id: number; name: string; kind: "page" | "event"; value: string } }) {
  const [editing, setEditing] = useState(false);
  const [state, action] = useActionState(deleteGoal, {} as GoalState);
  return (
    <>
      <MoreMenu label={`${goal.name}: more`} buttonClassName="grid size-7 place-items-center text-muted transition-colors hover:bg-hover hover:text-foreground">
        {(close) => (
          <>
            <Link href={`/analytics/${domain}/users?goal=${goal.id}`} role="menuitem" className={MENU_ITEM} onClick={close}>
              See its visits
            </Link>
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
            <form action={action}>
              <input type="hidden" name="id" value={goal.id} />
              <button type="submit" role="menuitem" className={`${MENU_ITEM} text-rose`}>
                Delete
              </button>
            </form>
          </>
        )}
      </MoreMenu>
      {state.error && <FormError message={state.error} />}
      {editing && <GoalDialog site={site} goal={goal} onClose={() => setEditing(false)} />}
    </>
  );
}

const KEY_HELP: Record<Provider, { label: string; hint: string; placeholder: string }> = {
  stripe: { label: "Restricted key", hint: "Developers → API keys → Create restricted key, with Read on Checkout Sessions and Invoices", placeholder: "rk_live_…" },
  polar: { label: "Organization access token", hint: "Settings → Developers → New token, with orders:read", placeholder: "polar_oat_…" },
  dodo: { label: "API key", hint: "Developer → API Keys → Add API key", placeholder: "Your Dodo Payments API key" },
};

/** Connects a provider, or gives it a new key. */
export function SourceForm({ site, provider, connected }: { site: number; provider: Provider; connected: boolean }) {
  const [state, action] = useActionState(saveSource, {} as SourceState);
  const help = KEY_HELP[provider];
  return (
    <form action={action} className="grid gap-3" data-testid={`source-${provider}`}>
      <input type="hidden" name="site" value={site} />
      <input type="hidden" name="provider" value={provider} />
      <Field label={help.label} htmlFor={`key-${provider}`} hint={help.hint}>
        <SecretInput id={`key-${provider}`} name="key" required placeholder={connected ? "A new key replaces the one in use" : help.placeholder} spellCheck={false} />
      </Field>
      {provider !== "stripe" && (
        <Field label="Mode" htmlFor={`mode-${provider}`} hint={provider === "polar" ? "Sandbox is sandbox.polar.sh" : "Test mode is Dodo's test environment"}>
          <Select id={`mode-${provider}`} name="mode" defaultValue="live" className="max-w-[220px]">
            <option value="live">Live</option>
            <option value="test">{provider === "polar" ? "Sandbox" : "Test"}</option>
          </Select>
        </Field>
      )}
      <FormError message={state.error} />
      {state.saved && <p className="text-[13px] text-teal">{state.saved}</p>}
      <div>
        <SubmitButton pending="Checking the key…" variant={connected ? "secondary" : "primary"} className="w-auto">
          {connected ? "Replace the key" : "Connect"}
        </SubmitButton>
      </div>
    </form>
  );
}

export function RemoveSourceButton({ site, provider, name }: { site: number; provider: Provider; name: string }) {
  const [state, action] = useActionState(removeSource, {} as SourceState);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2.5" onSubmit={(e) => !confirm(`Disconnect ${name}? Its payments are removed from these numbers.`) && e.preventDefault()}>
      <input type="hidden" name="site" value={site} />
      <input type="hidden" name="provider" value={provider} />
      <SubmitButton pending="Removing…" variant="secondary" size="sm" className="w-auto border-rose/60 text-rose hover:bg-rose/10">
        Disconnect
      </SubmitButton>
      <FormError message={state.error} />
    </form>
  );
}

/** Pulls new payments now, and says what came in. */
export function SyncNowButton({ site }: { site: number }) {
  const [state, action] = useActionState(syncNow, {} as SyncState);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2.5" data-testid="sync-now">
      <input type="hidden" name="site" value={site} />
      <SubmitButton pending="Syncing…" variant="secondary" size="sm" className="w-auto">
        <Icon icon={RefreshCwIcon} size={13} /> Sync now
      </SubmitButton>
      {state.message && <span className="text-[12px] text-teal">{state.message}</span>}
      <FormError message={state.error} />
    </form>
  );
}

/** Escape closes the drawer it's in (by going to `href`). */
export function CloseOnEscape({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && router.replace(href, { scroll: false });
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [router, href]);
  return null;
}

/** Users' goal filter: picking one goes straight to its visits. */
export function GoalPicker({ goals, value, hrefs }: { goals: { id: number; name: string }[]; value: string; hrefs: Record<string, string> }) {
  const router = useRouter();
  return (
    <Select aria-label="Visits that reached a goal" value={value} onChange={(e) => router.push(hrefs[e.target.value] ?? hrefs[""]!)} className="h-[35px] w-auto min-w-[170px] max-w-[240px]" data-testid="goal-picker">
      <option value="">Any goal or none</option>
      {goals.map((g) => (
        <option key={g.id} value={String(g.id)}>
          Reached {g.name}
        </option>
      ))}
    </Select>
  );
}

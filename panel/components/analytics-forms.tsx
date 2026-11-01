"use client";

import { PlusIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, type ReactNode } from "react";
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
import { GUIDES } from "@/lib/revenue-guides";
import { CopyButton, SubmitButton } from "./form";
import { Icon } from "./icon";
import { MENU_ITEM, MoreMenu } from "./menu";
import { Modal } from "./modal";
import { SettingsRow } from "./page";
import { Button, Field, FormError, Input, SecretInput, Select, cx } from "./ui";

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

/** A random secret of letters and digits, for a webhook whose secret is ours to choose (Lemon Squeezy's). */
function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[b % 62]).join("");
}

/**
 * Connects a provider, or gives it a new key. A webhook's provider (Creem,
 * Lemon Squeezy) shows where to add the webhook first, and keeps its signing
 * secret; for Lemon Squeezy, whose secret is ours to choose, one is made here.
 */
export function SourceForm({ site, provider, connected, webhookUrl }: { site: number; provider: Provider; connected: boolean; webhookUrl?: string }) {
  const [state, action] = useActionState(saveSource, {} as SourceState);
  const guide = GUIDES[provider];
  const [secret, setSecret] = useState("");
  // Made in the browser, once: what's pasted into Lemon Squeezy has to stay what's saved here.
  useEffect(() => {
    if (guide.webhook?.secret === "ours" && !connected) setSecret(newSecret());
  }, [guide.webhook?.secret, connected]);
  return (
    <form action={action} className="grid grid-cols-[minmax(0,1fr)] gap-3" data-testid={`source-${provider}`}>
      <input type="hidden" name="site" value={site} />
      <input type="hidden" name="provider" value={provider} />
      {guide.webhook && webhookUrl && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2 border border-border px-3 py-2.5 text-[13px]" data-testid={`webhook-${provider}`}>
          <span className="text-muted">{guide.webhook.where}:</span>
          <div className="flex min-w-0 items-center gap-2 bg-well px-2.5 py-1.5">
            <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]" data-testid="webhook-url">
              {webhookUrl}
            </code>
            <CopyButton text={webhookUrl} />
          </div>
          {guide.webhook.secret === "ours" && secret && (
            <div className="flex min-w-0 items-center gap-2 bg-well px-2.5 py-1.5">
              <span className="shrink-0 text-[12px] text-muted">Signing secret</span>
              <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]" data-testid="webhook-secret">
                {secret}
              </code>
              <CopyButton text={secret} />
            </div>
          )}
          <span className="text-[12px] text-muted">
            Events: {guide.webhook.events.map((e, i) => (
              <span key={e}>
                {i > 0 && ", "}
                <code className="font-mono">{e}</code>
              </span>
            ))}
          </span>
        </div>
      )}
      <Field label={guide.key.label} htmlFor={`key-${provider}`} hint={guide.key.hint}>
        <SecretInput
          id={`key-${provider}`}
          name="key"
          required
          {...(guide.webhook?.secret === "ours" && !connected ? { value: secret, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setSecret(e.target.value) } : {})}
          placeholder={connected ? (guide.webhook ? "A new secret replaces the one in use" : "A new key replaces the one in use") : guide.key.placeholder}
          spellCheck={false}
        />
      </Field>
      {guide.test && (
        <Field label="Mode" htmlFor={`mode-${provider}`} hint={guide.test.hint}>
          <Select id={`mode-${provider}`} name="mode" defaultValue="live" className="max-w-[220px]">
            <option value="live">Live</option>
            <option value="test">{guide.test.name}</option>
          </Select>
        </Field>
      )}
      <FormError message={state.error} />
      {state.saved && <p className="text-[13px] text-teal">{state.saved}</p>}
      <div>
        <SubmitButton pending={guide.webhook ? "Saving…" : "Checking the key…"} variant={connected ? "secondary" : "primary"} className="w-auto">
          {connected ? (guide.webhook ? "Replace the secret" : "Replace the key") : "Connect"}
        </SubmitButton>
      </div>
    </form>
  );
}

/** Code to copy: lines kept as they are, scrolling sideways when long. */
export function CodeBlock({ code, testId }: { code: string; testId?: string }) {
  return (
    <div className="flex items-start gap-2 bg-well py-2.5 pl-3 pr-2" data-testid={testId}>
      <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-[12.5px] leading-relaxed">{code}</pre>
      <CopyButton text={code} />
    </div>
  );
}

/** One provider at a time, as tabs: a dot on the connected ones. Starts on the first connected, or the first. */
export function RevenueTabs({ tabs }: { tabs: { id: Provider; name: string; connected: boolean; failing: boolean; panel: ReactNode }[] }) {
  const [current, setCurrent] = useState(() => tabs.find((t) => t.connected)?.id ?? tabs[0]!.id);
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3.5" data-testid="revenue-tabs">
      <div role="tablist" aria-label="Payment providers" className="flex max-w-full gap-0.5 self-start justify-self-start overflow-x-auto border border-border bg-field p-[3px]">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === current}
            onClick={() => setCurrent(t.id)}
            className={cx("flex items-center gap-1.5 whitespace-nowrap px-[13px] py-[5px] transition-colors duration-150", t.id === current ? "bg-raised text-foreground shadow-raise" : "text-muted hover:text-foreground")}
            data-testid={`tab-${t.id}`}
          >
            {t.name}
            {t.connected && <span className={cx("size-1.5", t.failing ? "bg-err-dot" : "bg-ok-dot")} title={t.failing ? "Failing" : "Connected"} />}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" hidden={t.id !== current} className="min-w-0" data-testid={`panel-${t.id}`}>
          {t.panel}
        </div>
      ))}
    </div>
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

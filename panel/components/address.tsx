"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { cancelPanelMoveAction, moveAppsDomainAction, movePanelAction, type AddressState, type AppsDomainState } from "@/app/actions/address";
import { CopyButton, SubmitButton } from "./form";
import { StatusText } from "./status";
import { Button, FormError, Input } from "./ui";

/** The DNS record to create before moving. */
function Record({ record }: { record: { type: string; name: string; value: string } }) {
  return (
    <div className="grid gap-2 rounded-xl bg-warn-band px-4 py-3" data-testid="address-record">
      <div className="grid items-end gap-x-4 gap-y-2 sm:grid-cols-[60px_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <div>
          <span className="mb-0.5 block text-[12px] text-dim">Type</span>
          <code className="font-mono text-[13px]">{record.type}</code>
        </div>
        <div className="min-w-0">
          <span className="mb-0.5 block text-[12px] text-dim">Name</span>
          <code className="block truncate font-mono text-[13px]">{record.name}</code>
        </div>
        <div className="min-w-0">
          <span className="mb-0.5 block text-[12px] text-dim">Value</span>
          <code className="block truncate font-mono text-[13px]">{record.value}</code>
        </div>
        <CopyButton text={record.value} />
      </div>
    </div>
  );
}

/** While a check runs: it may be the one that moves the panel. */
function CheckingNote() {
  const { pending } = useFormStatus();
  return pending ? <span className="text-[12px] text-dim">Checking. If the record is right, the move takes up to a minute.</span> : null;
}

/**
 * Moving the panel: enter an address, then the form waits for its DNS record.
 * The address is remembered on the server, so the wait survives a reload, and
 * the form checks every 15 seconds and finishes the move once it can.
 */
export function MovePanelForm({ waiting, ip }: { waiting: string | null; ip: string }) {
  const [state, action, isPending] = useActionState(async (prev: AddressState, form: FormData): Promise<AddressState> => {
    if (form.get("intent") === "cancel") {
      await cancelPanelMoveAction(String(form.get("host") ?? ""));
      return { cancelled: true };
    }
    return movePanelAction(prev, form);
  }, {} as AddressState);
  // The address being waited for: from the last check, or from the server on a fresh page.
  const host = state.waiting?.host ?? (Object.keys(state).length === 0 ? waiting : null);
  const form = useRef<HTMLFormElement>(null);
  const busy = useRef(isPending);
  busy.current = isPending;

  useEffect(() => {
    if (!host) return;
    const check = () => {
      if (!busy.current && document.visibilityState === "visible") form.current?.requestSubmit();
    };
    // A fresh page checks right away; after that, every 15 seconds.
    const first = state.waiting ? undefined : setTimeout(check, 300);
    const timer = setInterval(check, 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [host, state]);

  if (state.done) {
    return (
      <div className="grid gap-2" data-testid="move-panel">
        <p className="text-[13.5px] text-teal" data-testid="moved">
          Moved. Open{" "}
          <a href={state.done} className="font-medium underline underline-offset-4">
            {state.done}
          </a>{" "}
          and sign in again: each address has its own sign-in. The old address redirects there.
        </p>
        {state.warning && <p className="text-[13px] text-gold">{state.warning}</p>}
      </div>
    );
  }

  if (host) {
    return (
      <form ref={form} action={action} className="grid gap-3" data-testid="move-panel-waiting">
        <input type="hidden" name="host" value={host} />
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <StatusText status="warn" label="Waiting" pulse />
          <span className="min-w-0 text-[12px] text-muted">
            to move to <code className="font-mono text-[13.5px] text-foreground">{host}</code>
          </span>
        </div>
        <p className="text-[12px] text-muted">{state.waiting?.message ?? "Checking the DNS record…"}</p>
        <Record record={{ type: "A", name: host, value: ip }} />
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          <SubmitButton pending="Checking…" variant="secondary" size="sm" className="w-auto">
            Check again
          </SubmitButton>
          <Button type="submit" name="intent" value="cancel" variant="ghost" size="sm">
            Cancel
          </Button>
          <CheckingNote />
        </div>
        <p className="text-[12px] text-dim">Checks every 15 seconds while this page is open, and moves the panel as soon as the record is right.</p>
      </form>
    );
  }

  return (
    <form ref={form} action={action} className="grid gap-3" data-testid="move-panel">
      <div className="flex flex-wrap gap-2">
        <Input name="host" aria-label="New panel address" placeholder="panel.example.com" autoComplete="off" spellCheck={false} required className="min-w-0 flex-1" />
        <SubmitButton pending="Checking…" className="w-auto shrink-0">
          Move the panel
        </SubmitButton>
      </div>
      <FormError message={state.error} />
    </form>
  );
}

export function MoveAppsForm({ current }: { current: string }) {
  const [state, action] = useActionState(moveAppsDomainAction, {} as AppsDomainState);
  return (
    <form action={action} className="grid gap-3" data-testid="move-apps">
      <div className="flex flex-wrap gap-2">
        <Input name="domain" aria-label="New apps domain" placeholder="apps.example.com" autoComplete="off" spellCheck={false} required className="min-w-0 flex-1" />
        <SubmitButton pending="Moving the apps…" variant="secondary" className="w-auto shrink-0">
          Move app URLs
        </SubmitButton>
      </div>
      <FormError message={state.error} />
      {state.record && <Record record={state.record} />}
      {state.done && (
        <p className="text-[13.5px] text-teal">
          Free URLs are now &lt;app&gt;.{state.done}
          {state.moved ? ` (${state.moved} live site${state.moved === 1 ? "" : "s"} updated)` : ""}. The old ones under {current} redirect.
          {state.failed?.length ? <span className="text-gold"> Couldn&apos;t update {state.failed.join(", ")}: they get the new URL with their next deploy.</span> : null}
        </p>
      )}
    </form>
  );
}

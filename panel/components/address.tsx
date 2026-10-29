"use client";

import { useActionState } from "react";
import { moveAppsDomainAction, movePanelAction, type AddressState, type AppsDomainState } from "@/app/actions/address";
import { CopyButton, SubmitButton } from "./form";
import { FormError, Input } from "./ui";

/** The DNS record to create before moving. */
function Record({ record }: { record: { type: string; name: string; value: string } }) {
  return (
    <div className="grid gap-2 border-l-2 border-gold bg-gold/7 px-4 py-3" data-testid="address-record">
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

export function MovePanelForm() {
  const [state, action] = useActionState(movePanelAction, {} as AddressState);
  return (
    <form action={action} className="grid gap-3" data-testid="move-panel">
      <div className="flex flex-wrap gap-2">
        <Input name="host" aria-label="New panel address" placeholder="panel.example.com" autoComplete="off" spellCheck={false} required className="min-w-0 flex-1" />
        <SubmitButton pending="Moving… (up to a minute)" className="w-auto shrink-0">
          Move the panel
        </SubmitButton>
      </div>
      <FormError message={state.error} />
      {state.record && <Record record={state.record} />}
      {state.pending && (
        <p className="text-[13.5px] text-gold">
          The panel also answers on https://{state.pending} now, but its certificate isn&apos;t ready yet (DNS may still be spreading). Nothing else changed: press Move again in a few minutes.
        </p>
      )}
      {state.done && (
        <p className="text-[13.5px] text-teal" data-testid="moved">
          Moved. Open{" "}
          <a href={state.done} className="font-medium underline underline-offset-4">
            {state.done}
          </a>{" "}
          and sign in again: each address has its own sign-in. The old address redirects there.
        </p>
      )}
      {state.warning && <p className="text-[13px] text-gold">{state.warning}</p>}
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

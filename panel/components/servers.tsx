"use client";

import { useActionState, useState } from "react";
import { addServerAction, checkServerAction, removeServerAction, type ServerFormState } from "@/app/actions/servers";
import { CopyButton, SubmitButton } from "./form";
import { Modal } from "./modal";
import { Button, Field, FormError, Input } from "./ui";

export function AddServerForm() {
  const [state, action] = useActionState(addServerAction, {} as ServerFormState);
  return (
    <form action={action} className="grid gap-3" data-testid="add-server">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_100px]">
        <Field label="Name" htmlFor="server-name">
          <Input id="server-name" name="name" placeholder="eu-2" />
        </Field>
        <Field label="Address" htmlFor="server-host" hint="Its IP, or a host name">
          <Input id="server-host" name="host" placeholder="203.0.113.7" spellCheck={false} />
        </Field>
        <Field label="SSH port" htmlFor="server-port">
          <Input id="server-port" name="port" defaultValue="22" inputMode="numeric" />
        </Field>
      </div>
      <FormError message={state.error} />
      {state.saved && <p className="text-[13px] text-teal">{state.saved}</p>}
      <SubmitButton pending="Adding…" className="w-fit">
        Add server
      </SubmitButton>
    </form>
  );
}

export function InstallCommand({ command }: { command: string }) {
  return (
    <div className="grid gap-2">
      <pre className="overflow-x-auto border border-border bg-code p-3 font-mono text-[12px] leading-[1.5] text-[#e5e5e5]" data-testid="server-install-command">
        {command}
      </pre>
      <CopyButton text={command} label="Copy the command" />
    </div>
  );
}

export function CheckServerButton({ id }: { id: number }) {
  const [state, action] = useActionState(checkServerAction, {} as ServerFormState);
  return (
    <form action={action} className="grid justify-items-start gap-1.5">
      <input type="hidden" name="id" value={id} />
      <SubmitButton pending="Checking…" variant="secondary" size="sm" className="w-auto">
        Check connection
      </SubmitButton>
      <FormError message={state.error} />
      {state.saved && <p className="text-[12px] text-teal">{state.saved}</p>}
    </form>
  );
}

export function RemoveServer({ id, name }: { id: number; name: string }) {
  const [state, action] = useActionState(removeServerAction, {} as ServerFormState);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="danger" size="sm" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Remove ${name}?`} description="The panel forgets it. Its apps and agent stay on it and keep running.">
        <form action={action} className="grid gap-3 px-[18px] py-5">
          <input type="hidden" name="id" value={id} />
          <Field label={`Type ${name} to confirm`} htmlFor="confirm-server">
            <Input id="confirm-server" name="confirm" autoComplete="off" />
          </Field>
          <FormError message={state.error} />
          {state.saved && <p className="text-[13px] text-teal">{state.saved}</p>}
          <SubmitButton pending="Removing…" variant="danger" className="w-fit">
            Remove {name}
          </SubmitButton>
        </form>
      </Modal>
    </>
  );
}

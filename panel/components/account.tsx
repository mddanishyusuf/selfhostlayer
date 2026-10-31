"use client";

import { useActionState, useState } from "react";
import { changePasswordAction, newRecoveryCodesAction, type AccountState } from "@/app/actions/account";
import { CopyButton, SubmitButton } from "./form";
import { Button, Field, FormError, Input } from "./ui";

function Toggle({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <div className="grid gap-3 border-l-2 border-border-strong pl-4">{children}</div>
  ) : (
    <div>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
    </div>
  );
}

export function ChangePasswordForm() {
  const [state, action] = useActionState(changePasswordAction, {} as AccountState);
  return (
    <Toggle label="Change password…">
      {state.ok ? (
        <p className="text-[13.5px] text-teal" data-testid="password-changed">
          {state.ok}
        </p>
      ) : (
        <form action={action} className="grid gap-3" data-testid="change-password">
          <Field label="Current password" htmlFor="current-password">
            <Input id="current-password" name="current" type="password" autoComplete="current-password" required />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="New password" htmlFor="new-password" hint="At least 12 characters">
              <Input id="new-password" name="password" type="password" autoComplete="new-password" required minLength={12} />
            </Field>
            <Field label="New password again" htmlFor="confirm-password">
              <Input id="confirm-password" name="confirm" type="password" autoComplete="new-password" required minLength={12} />
            </Field>
          </div>
          <FormError message={state.error} />
          <div>
            <SubmitButton pending="Changing…" className="w-auto">
              Change password
            </SubmitButton>
          </div>
        </form>
      )}
    </Toggle>
  );
}

export function RecoveryCodesForm() {
  const [state, action] = useActionState(newRecoveryCodesAction, {} as AccountState);
  return (
    <Toggle label="New recovery codes…">
      {state.codes ? (
        <div className="grid gap-3" data-testid="new-recovery-codes">
          <p className="text-[13.5px] text-gold">{state.ok}</p>
          <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-[10px] border border-border-strong p-4 font-mono text-[13px] tabular-nums">
            {state.codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div>
            <CopyButton text={state.codes.join("\n")} label="Copy all" />
          </div>
        </div>
      ) : (
        <form action={action} className="grid gap-3" data-testid="recovery-codes">
          <p className="text-[13.5px] text-muted">Each code signs you in once without your phone. Making new ones turns off the old ones.</p>
          <Field label="Current password" htmlFor="recovery-password">
            <Input id="recovery-password" name="current" type="password" autoComplete="current-password" required />
          </Field>
          <FormError message={state.error} />
          <div>
            <SubmitButton pending="Making codes…" className="w-auto">
              Make new codes
            </SubmitButton>
          </div>
        </form>
      )}
    </Toggle>
  );
}

"use client";

import { useActionState, useState } from "react";
import {
  confirmSetup2fa,
  submitAccount,
  submitLogin,
  submitLogin2fa,
  submitSetupToken,
  type FormState,
} from "@/app/actions/auth";
import { CodeInput, SubmitButton } from "./form";
import { Field, FormError, Input } from "./ui";

const initial: FormState = {};

export function SetupTokenForm() {
  const [state, action] = useActionState(submitSetupToken, initial);
  return (
    <form action={action} className="grid gap-4">
      <Field label="Setup token" htmlFor="token" hint="Printed at the end of the installer, in the box.">
        <Input
          id="token"
          name="token"
          required
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste the token"
          aria-invalid={!!state.error}
          className="font-mono text-[13px]"
        />
      </Field>
      <FormError message={state.error} />
      <SubmitButton pending="Checking…">Continue</SubmitButton>
    </form>
  );
}

export function AccountForm() {
  const [state, action] = useActionState(submitAccount, initial);
  return (
    <form action={action} className="grid gap-4">
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" required autoFocus autoComplete="email" defaultValue={state.email} />
      </Field>
      <Field label="Password" htmlFor="password" hint="At least 12 characters.">
        <Input id="password" name="password" type="password" required minLength={12} autoComplete="new-password" />
      </Field>
      <Field label="Confirm password" htmlFor="confirm">
        <Input id="confirm" name="confirm" type="password" required minLength={12} autoComplete="new-password" />
      </Field>
      <FormError message={state.error} />
      <SubmitButton pending="Saving…">Continue</SubmitButton>
    </form>
  );
}

export function Setup2faForm() {
  const [state, action] = useActionState(confirmSetup2fa, initial);
  return (
    <form action={action} className="grid gap-4">
      <Field label="6-digit code from the app" htmlFor="code-0">
        <CodeInput />
      </Field>
      <FormError message={state.error} />
      <SubmitButton pending="Verifying…">Turn on 2FA and finish</SubmitButton>
    </form>
  );
}

export function LoginForm() {
  const [state, action] = useActionState(submitLogin, initial);
  return (
    <form action={action} className="grid gap-4">
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" required autoFocus autoComplete="username" defaultValue={state.email} />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input id="password" name="password" type="password" required autoComplete="current-password" aria-invalid={!!state.error} />
      </Field>
      <FormError message={state.error} />
      <SubmitButton pending="Signing in…">Continue</SubmitButton>
    </form>
  );
}

export function Login2faForm() {
  const [state, action] = useActionState(submitLogin2fa, initial);
  const [recovery, setRecovery] = useState(false);
  return (
    <form action={action} className="grid gap-4">
      {recovery ? (
        <Field label="Recovery code" htmlFor="code" hint="Each recovery code works once.">
          <Input id="code" name="code" required autoFocus autoComplete="off" spellCheck={false} placeholder="xxxx-xxxx" className="font-mono" />
        </Field>
      ) : (
        <Field label="6-digit code from your authenticator app" htmlFor="code-0">
          <CodeInput />
        </Field>
      )}
      <FormError message={state.error} />
      <SubmitButton pending="Verifying…">Verify</SubmitButton>
      <button type="button" onClick={() => setRecovery(!recovery)} className="text-[13px] text-muted transition-colors duration-150 hover:text-foreground">
        {recovery ? "Use the authenticator app instead" : "Lost your phone? Use a recovery code"}
      </button>
    </form>
  );
}

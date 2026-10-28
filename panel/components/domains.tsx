"use client";

import { useActionState, useEffect, useRef } from "react";
import { addDomainAction, type DomainState } from "@/app/actions/domains";
import { SubmitButton } from "./form";
import { FormError, Input } from "./ui";

export function AddDomainForm({ slug }: { slug: string }) {
  const [state, action] = useActionState(addDomainAction, {} as DomainState);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.added) form.current?.reset();
  }, [state]);
  return (
    <form ref={form} action={action} className="grid gap-3">
      <input type="hidden" name="slug" value={slug} />
      <div className="flex gap-2">
        <Input name="host" placeholder="example.com" aria-label="Domain" autoComplete="off" spellCheck={false} required className="min-w-0 flex-1" />
        <SubmitButton pending="Checking DNS…" className="w-auto shrink-0 px-4">
          Add
        </SubmitButton>
      </div>
      <label className="flex items-center gap-2 text-[13px] text-muted">
        <input type="checkbox" name="www" defaultChecked /> Also add www, redirecting to the domain
      </label>
      <FormError message={state.error} />
    </form>
  );
}

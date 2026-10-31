"use client";

import { useActionState } from "react";
import { installIntegration, type InstallState } from "@/app/actions/integrations";
import { SubmitButton } from "./form";

/** Install: makes the integration and opens its first deployment, whose log shows it coming up. */
export function InstallButton({ app }: { app: string }) {
  const [state, action] = useActionState(installIntegration, {} as InstallState);
  return (
    <form action={action} className="grid justify-items-end gap-1" data-testid={`install-${app}`}>
      <input type="hidden" name="app" value={app} />
      <SubmitButton pending="Installing…" size="sm" className="w-auto">
        Install
      </SubmitButton>
      {state.error && <p className="max-w-[280px] text-right text-[12px] text-rose">{state.error}</p>}
    </form>
  );
}

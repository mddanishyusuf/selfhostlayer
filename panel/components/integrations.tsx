"use client";

import { useActionState } from "react";
import { installIntegration, refreshCatalog, updateIntegration, type InstallState } from "@/app/actions/integrations";
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

/** Update: backs the app up (when backups are on), then deploys the new version beside the old one. */
export function UpdateButton({ slug, version, size = "sm" }: { slug: string; version: string; size?: "sm" | "md" }) {
  const [state, action] = useActionState(updateIntegration, {} as InstallState);
  return (
    <form action={action} className="grid justify-items-end gap-1" data-testid={`update-${slug}`}>
      <input type="hidden" name="slug" value={slug} />
      <SubmitButton pending="Updating…" size={size} className="w-auto">
        Update to {version}
      </SubmitButton>
      {state.error && <p className="max-w-[280px] text-right text-[12px] text-rose">{state.error}</p>}
    </form>
  );
}

/** Reads the catalog again now, for a version published a moment ago. */
export function CheckCatalogButton() {
  return (
    <form action={refreshCatalog} data-testid="check-catalog">
      <SubmitButton pending="Checking…" variant="secondary" size="sm" className="w-auto">
        Check again
      </SubmitButton>
    </form>
  );
}

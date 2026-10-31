"use client";

import { useActionState, useState } from "react";
import { saveAccessAction, type AccessState } from "@/app/actions/access";
import { SubmitButton } from "./form";
import { FormError, cx } from "./ui";

const TAILSCALE = "100.64.0.0/10 fd7a:115c:a1e0::/48";
const MODES = [
  ["anyone", "Anyone"],
  ["ips", "Only these addresses"],
  ["tailscale", "Tailscale only"],
] as const;

export function AccessForm({ allow, you }: { allow: string[]; you: string | null }) {
  const [state, action] = useActionState(saveAccessAction, {} as AccessState);
  const [mode, setMode] = useState<(typeof MODES)[number][0]>(!allow.length ? "anyone" : allow.join(" ") === TAILSCALE ? "tailscale" : "ips");
  return (
    <form action={action} className="grid gap-3" data-testid="access">
      <input type="hidden" name="mode" value={mode} />
      <div className="inline-flex flex-wrap gap-0.5 justify-self-start rounded-lg border border-border-strong p-[3px]" role="radiogroup" aria-label="Who may open the panel">
        {MODES.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            onClick={() => setMode(value)}
            className={cx("h-7 rounded-md px-3 text-[13px] font-medium transition-colors duration-150", mode === value ? "bg-selected text-foreground" : "text-muted hover:text-foreground")}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "anyone" && <p className="text-[13.5px] text-muted">The sign-in page is open to the internet; signing in takes your password and a code from your authenticator app.</p>}
      {mode === "ips" && (
        <div className="grid gap-1.5">
          <textarea
            name="ips"
            rows={3}
            spellCheck={false}
            defaultValue={allow.length && allow.join(" ") !== TAILSCALE ? allow.join("\n") : (you ?? "")}
            placeholder={"203.0.113.7\n198.51.100.0/24"}
            aria-label="Allowed addresses"
            className="w-full rounded-[10px] border border-border-strong bg-field p-3 font-mono text-[13px] outline-none placeholder:text-dim focus:border-accent"
          />
          <p className="text-[12.5px] text-dim">One per line: an IP, or a range like 203.0.113.0/24.{you ? ` You're on ${you} now.` : ""}</p>
        </div>
      )}
      {mode === "tailscale" && (
        <p className="text-[13.5px] text-muted">
          Only devices on your tailnet (100.64.0.0/10) can open the panel. Install Tailscale on this server and open the panel over it before you save.{you ? ` You're on ${you} now.` : ""}
        </p>
      )}
      <FormError message={state.error} />
      {state.saved && <p className="text-[13.5px] text-teal">{state.saved}</p>}
      <div>
        <SubmitButton pending="Saving…" className="w-auto">
          Save
        </SubmitButton>
      </div>
    </form>
  );
}

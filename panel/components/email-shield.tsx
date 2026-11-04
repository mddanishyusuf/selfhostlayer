"use client";

// Shield's page (PLAN-EMAIL-2.md): its checks, AbuseIPDB's key, its lists and
// Clean the list.
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import * as A from "@/app/actions/email";
import { SHIELD_CHECKS, type ShieldAction, type ShieldCheck } from "@/lib/shield-checks";
import { SubmitButton } from "./form";
import { Button, FormError, SecretInput, cx } from "./ui";

const initial: A.FormState = {};
const ACTIONS: { id: ShieldAction; label: string }[] = [
  { id: "refuse", label: "Refuse" },
  { id: "flag", label: "Flag" },
  { id: "off", label: "Off" },
];

function Saved({ state }: { state: A.FormState }) {
  return (
    <>
      <FormError message={state.error} />
      {state.saved && <p className="text-[13px] text-teal">{state.saved}</p>}
    </>
  );
}

/** One row per check, with Refuse, Flag or Off. */
export function ShieldForm({ brandId, checks, allowDatacenter }: { brandId: number; checks: Record<ShieldCheck, ShieldAction>; allowDatacenter: boolean }) {
  const [state, run] = useActionState(A.saveShield, initial);
  const [values, setValues] = useState(checks);
  return (
    <form action={run} className="grid gap-3" data-testid="shield-form">
      <input type="hidden" name="brand" value={brandId} />
      <div className="border border-border">
        {SHIELD_CHECKS.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border-soft px-3.5 py-2.5 last:border-b-0" data-testid={`shield-${c.id}`}>
            <input type="hidden" name={`check-${c.id}`} value={values[c.id]} />
            <span className="grid min-w-[220px] flex-1 gap-px">
              <b className="text-[13px] font-bold">
                {c.label}
                {!c.address && <span className="ml-1.5 text-[11px] font-normal text-dim">sign-up forms</span>}
              </b>
              <span className="text-[12px] text-muted">{c.about}</span>
            </span>
            <span className="inline-flex gap-0.5 border border-border bg-field p-[3px]" role="radiogroup" aria-label={c.label}>
              {ACTIONS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  aria-checked={values[c.id] === a.id}
                  onClick={() => setValues({ ...values, [c.id]: a.id })}
                  className={cx("px-[11px] py-[3px] text-[12px] transition-colors duration-150", values[c.id] === a.id ? cx("bg-raised shadow-raise", a.id === "refuse" ? "text-err" : a.id === "flag" ? "text-warn" : "text-foreground") : "text-muted hover:text-foreground")}
                >
                  {a.label}
                </button>
              ))}
            </span>
          </div>
        ))}
      </div>
      <label className="flex items-start gap-2 text-[13px]">
        <input type="checkbox" name="allowDatacenter" defaultChecked={allowDatacenter} className="mt-[3px]" />
        <span>
          Allow sign-ups from data centers
          <span className="block text-[12px] text-muted">Cloud servers and hosting. Turn this on for a B2B product whose users may come through a company VPN.</span>
        </span>
      </label>
      <p className="text-[12px] text-muted">
        <b className="text-foreground">Refuse</b> keeps the address out, and the form still says thanks, so a bot learns nothing. <b className="text-foreground">Flag</b> keeps it, but campaigns and automations skip it until you approve it on its contact page.
      </p>
      <Saved state={state} />
      <div>
        <SubmitButton pending="Saving…" className="w-auto">
          Save
        </SubmitButton>
      </div>
    </form>
  );
}

export function AbuseKeyForm({ has }: { has: boolean }) {
  const [state, run] = useActionState(A.saveAbuseKey, initial);
  return (
    <form action={run} className="grid gap-2.5" data-testid="abuseipdb-form">
      <p className="text-[13px]">{has ? "A key is saved: sign-ups are checked against AbuseIPDB's reports (75% confidence or more counts)." : "No key: Tor and data centers are still checked, from lists on this server."}</p>
      <div className="flex flex-wrap gap-2">
        <SecretInput name="key" placeholder={has ? "A new key replaces it" : "Your AbuseIPDB API key"} className="min-w-0 flex-1 font-mono text-[13px]" />
        <SubmitButton pending="Saving…" className="w-auto">
          Save key
        </SubmitButton>
        {has && (
          <Button type="submit" name="intent" value="remove" variant="secondary">
            Remove
          </Button>
        )}
      </div>
      <Saved state={state} />
    </form>
  );
}

export function RefreshLists() {
  const [state, run] = useActionState(A.refreshShieldLists, initial);
  return (
    <form action={run} className="grid gap-2">
      <div>
        <SubmitButton pending="Downloading…" variant="secondary" size="sm" className="w-auto">
          Download them now
        </SubmitButton>
      </div>
      <Saved state={state} />
    </form>
  );
}

interface Scan {
  state: "running" | "done" | "failed";
  checked: number;
  total: number;
  error: string | null;
  byCheck: Partial<Record<ShieldCheck, number>>;
  examples: Partial<Record<ShieldCheck, { email: string; detail: string }[]>>;
}

/** Clean the list: start, watch it run (the page reloads every 2 s), then pick what to flag or unsubscribe. */
export function CleanList({ brandId, scan }: { brandId: number; scan: Scan | null }) {
  const router = useRouter();
  const [state, run] = useActionState(A.applyCleanList, initial);
  useEffect(() => {
    if (scan?.state !== "running") return;
    const t = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(t);
  }, [scan?.state, router]);
  const found = scan ? (Object.entries(scan.byCheck) as [ShieldCheck, number][]) : [];
  return (
    <div className="grid gap-3" data-testid="clean-list">
      {(!scan || scan.state !== "running") && !state.saved && (
        <form action={A.startCleanList}>
          <input type="hidden" name="brand" value={brandId} />
          <SubmitButton pending="Starting…" variant={scan ? "secondary" : "primary"} className="w-auto">
            {scan ? "Check again" : "Check every contact"}
          </SubmitButton>
        </form>
      )}
      {scan?.state === "running" && (
        <p className="text-[13px] text-muted" data-testid="clean-running">
          <span className="mr-2 inline-block size-2 rounded-full bg-warn-dot [animation:pulse-ring_1.6s_infinite]" />
          Checking… {scan.checked.toLocaleString("en")} of {scan.total.toLocaleString("en")} contacts
        </p>
      )}
      {scan?.state === "failed" && <FormError message={`The check stopped: ${scan.error}`} />}
      {scan?.state === "done" && !state.saved && (
        <form action={run} className="grid gap-3" data-testid="clean-result">
          <input type="hidden" name="brand" value={brandId} />
          <p className="text-[13px]">
            Checked <b>{scan.total.toLocaleString("en")}</b> subscribed and unconfirmed contacts.{" "}
            {found.length ? "Pick what to act on:" : <span className="text-ok">Nothing to clean: every address passed.</span>}
          </p>
          {found.length > 0 && (
            <>
              <div className="border border-border">
                {found.map(([id, count]) => (
                  <label key={id} className="flex items-start gap-2.5 border-b border-border-soft px-3.5 py-2.5 text-[13px] last:border-b-0">
                    <input type="checkbox" name="checks" value={id} defaultChecked className="mt-[3px]" />
                    <span className="grid min-w-0 gap-px">
                      <span>
                        <b>{SHIELD_CHECKS.find((c) => c.id === id)?.label}</b>: {count.toLocaleString("en")} contact{count === 1 ? "" : "s"}
                      </span>
                      <span className="truncate text-[12px] text-muted">{scan.examples[id]?.map((x) => `${x.email} (${x.detail})`).join(", ")}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-[13px]">
                <label className="flex items-center gap-2">
                  <input type="radio" name="action" value="flag" defaultChecked /> Flag them: kept, skipped by sends until approved
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="action" value="unsubscribe" /> Unsubscribe them
                </label>
              </div>
              <div>
                <SubmitButton pending="Applying…" className="w-auto">
                  Apply
                </SubmitButton>
              </div>
            </>
          )}
        </form>
      )}
      <Saved state={state} />
    </div>
  );
}

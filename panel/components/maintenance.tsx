"use client";

import { useEffect, useState, useTransition } from "react";
import { checkUpdatesAction, repairAction, startUpdateAction, type RepairResult, type UpdateCheck } from "@/app/actions/maintenance";
import { Button, FormError } from "./ui";

interface Status {
  running: boolean;
  result: string | null;
  version: string;
  log: string[];
}

/** Check, update, and follow the update while the panel restarts under it. */
export function UpdatePanel({ current }: { current: string }) {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!target || done) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/api/update", { cache: "no-store" });
        if (!res.ok) return; // the panel or the agent is restarting
        const s = (await res.json()) as Status;
        setStatus(s);
        if (!s.running && s.version === target) {
          setDone(true);
          setTimeout(() => location.reload(), 1500);
        } else if (!s.running && s.result && s.result !== "success") {
          setError(`The update stopped (${s.result}). Your apps kept running; the log below says why.`);
          setTarget(null);
        }
      } catch {
        // still restarting
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [target, done]);

  if (target) {
    return (
      <div className="grid gap-2" data-testid="update-progress">
        <p className="text-[13.5px]">{done ? <span className="text-teal">Updated to {target}. Reloading…</span> : <span className="text-gold">Updating to {target}… the panel restarts on the way; your apps keep running.</span>}</p>
        {status?.log.length ? (
          <pre className="max-h-56 overflow-auto rounded-md bg-code p-3 font-mono text-[12px] leading-relaxed text-[#ece8e3]">{status.log.slice(-15).join("\n")}</pre>
        ) : null}
      </div>
    );
  }
  return (
    <div className="grid gap-3" data-testid="updates">
      {check?.latest && check.available ? (
        <div className="grid gap-2">
          <p className="text-[13.5px]">
            <b className="font-semibold">{check.latest.version}</b> is available{check.latest.date ? ` (${check.latest.date})` : ""}. You have {current}.
          </p>
          {check.latest.notes && <p className="whitespace-pre-line text-[13px] text-muted">{check.latest.notes}</p>}
          <div>
            <Button
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await startUpdateAction(check.latest!.version);
                  if (r.error) setError(r.error);
                  else setTarget(r.to ?? check.latest!.version);
                })
              }
            >
              {pending ? "Starting…" : `Update to ${check.latest.version}`}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" disabled={pending} onClick={() => start(async () => setCheck(await checkUpdatesAction()))}>
            {pending ? "Checking…" : "Check for updates"}
          </Button>
          {check && !check.error && !check.available && <span className="text-[13px] text-muted">You&apos;re on the latest version.</span>}
        </div>
      )}
      <FormError message={error ?? check?.error ?? null} />
    </div>
  );
}

/** Puts back generated files edited or deleted by hand (the same as `layer repair`). */
export function RepairButton() {
  const [result, setResult] = useState<RepairResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="grid gap-2" data-testid="repair">
      <div>
        <Button variant="secondary" disabled={pending} onClick={() => start(async () => setResult(await repairAction()))}>
          {pending ? "Checking…" : "Check and repair"}
        </Button>
      </div>
      {result?.error && <FormError message={result.error} />}
      {result && !result.error && (
        <p className="text-[13.5px] text-muted">
          {result.restored?.length ? (
            <>
              <span className="text-teal">Put back {result.restored.length} file{result.restored.length === 1 ? "" : "s"}:</span> {result.restored.join(", ")}.
              {result.restarted?.length ? ` Restarted ${result.restarted.join(", ")}.` : ""}
            </>
          ) : (
            `Nothing to repair: all ${result.checked} generated files are as the agent wrote them.`
          )}
        </p>
      )}
    </div>
  );
}

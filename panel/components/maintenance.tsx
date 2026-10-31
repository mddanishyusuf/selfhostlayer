"use client";

import { useEffect, useState, useTransition } from "react";
import { checkUpdatesAction, repairAction, setAutoCheckAction, startUpdateAction, type RepairResult } from "@/app/actions/maintenance";
import type { Release, UpdateState } from "@/lib/updates";
import { Button, FormError, StatusDot } from "./ui";

interface Status {
  running: boolean;
  result: string | null;
  version: string;
  log: string[];
}

/** Starts an update, then follows it while the panel restarts under it, until the new version answers. */
export function useUpdate() {
  const [target, setTarget] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (phase !== "running") return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch("/api/update", { cache: "no-store" });
        if (!res.ok) return; // the panel or the agent is restarting
        const s = (await res.json()) as Status;
        setLog(s.log);
        if (!s.running && s.version === target) {
          setPhase("done");
          setTimeout(() => location.reload(), 1500);
        } else if (!s.running && s.result && s.result !== "success") {
          setError(`The update stopped (${s.result}). Your apps kept running; the log below says why.`);
          setPhase("failed");
        }
      } catch {
        // still restarting
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [phase, target]);

  const begin = (version: string) =>
    start(async () => {
      setError(null);
      const r = await startUpdateAction(version);
      if (r.error) return setError(r.error);
      setTarget(r.to ?? version);
      setLog([]);
      setPhase("running");
    });
  return { target, phase, log, error, pending, begin, busy: phase === "running" || phase === "done" };
}

export type UpdateRun = ReturnType<typeof useUpdate>;

/** The installer's last lines, on the always-dark log pane. */
export function UpdateLog({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return <pre className="max-h-56 overflow-auto rounded-xl bg-code p-3.5 font-mono text-[12px] leading-relaxed text-[#e5e5ea]">{lines.slice(-15).join("\n")}</pre>;
}

export function UpdateProgress({ run }: { run: UpdateRun }) {
  return (
    <div className="grid gap-2" data-testid="update-progress">
      <p className="flex items-center gap-2 text-[13.5px]">
        {run.phase === "done" ? (
          <>
            <StatusDot status="ok" /> <span><b className="font-semibold text-teal">Updated</b> to {run.target}. Reloading…</span>
          </>
        ) : (
          <>
            <StatusDot status="warn" pulse /> <span><b className="font-semibold text-gold">Updating</b> to {run.target}. The panel restarts on the way; your apps keep running.</span>
          </>
        )}
      </p>
      <UpdateLog lines={run.log} />
    </div>
  );
}

/** "0.2.0 is available (date). You have 0.1.0." and what's new. */
function ReleaseOffer({ current, release }: { current: string; release: Release }) {
  return (
    <div className="grid gap-1.5">
      <p className="text-[13.5px]">
        <b className="font-semibold">{release.version}</b> is available{release.date ? ` (${release.date})` : ""}. You have {current}.
      </p>
      {release.notes && <p className="whitespace-pre-line text-[12px] text-muted">{release.notes}</p>}
    </div>
  );
}

/** Settings → Version: the last check, Check for updates, and the update itself. */
export function UpdatePanel({ current, state, offered, checked, auto }: { current: string; state: UpdateState | null; offered: Release | null; checked: string | null; auto: boolean }) {
  const run = useUpdate();
  const [checking, startCheck] = useTransition();
  const [, startAuto] = useTransition();
  if (run.busy) return <UpdateProgress run={run} />;
  const upToDate = !offered && !!state && !state.error && state.current === current;
  return (
    <div className="grid gap-3" data-testid="updates" data-checked-at={state?.checkedAt ?? 0}>
      {offered ? <ReleaseOffer current={current} release={offered} /> : upToDate && <p className="text-[12px] text-muted">You&apos;re on the latest version.</p>}
      <div className="flex flex-wrap items-center gap-2">
        {offered && (
          <Button disabled={run.pending} onClick={() => run.begin(offered.version)}>
            {run.pending ? "Starting…" : `Update to ${offered.version}`}
          </Button>
        )}
        <Button variant="secondary" disabled={checking} onClick={() => startCheck(() => checkUpdatesAction())}>
          {checking ? "Checking…" : "Check for updates"}
        </Button>
        <span className="text-[12px] text-dim">{checked ? `Checked ${checked}` : "Not checked yet"}</span>
      </div>
      <label className="flex w-fit items-center gap-2 text-[12px] text-muted">
        <input type="checkbox" defaultChecked={auto} onChange={(e) => startAuto(() => setAutoCheckAction(e.target.checked))} className="size-4 accent-[var(--accent)]" />
        Check for updates every 6 hours
      </label>
      <FormError message={run.error ?? (state?.error ? `Couldn't check for updates: ${state.error}` : null)} />
      {run.phase === "failed" && <UpdateLog lines={run.log} />}
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
        <p className="text-[12px] text-muted">
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

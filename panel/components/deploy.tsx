"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { importAndDeploy, type ImportState } from "@/app/actions/projects";
import { SubmitButton } from "./form";
import { Field, FormError, Input, cx } from "./ui";

/** Import button for one repo in the list. */
export function ImportButton({ repo, installationId }: { repo: string; installationId: number }) {
  const [state, action] = useActionState(importAndDeploy, {} as ImportState);
  return (
    <form action={action} className="grid justify-items-end gap-1">
      <input type="hidden" name="repo" value={repo} />
      <input type="hidden" name="installationId" value={installationId} />
      <SubmitButton pending="Importing…" className="h-8 w-auto px-3 text-[13px]">
        Import
      </SubmitButton>
      {state.error && <p className="max-w-[260px] text-right text-[12px] text-err">{state.error}</p>}
    </form>
  );
}

/** Any public repo by URL, with an optional folder and branch. */
export function PublicRepoForm() {
  const [state, action] = useActionState(importAndDeploy, {} as ImportState);
  return (
    <form action={action} className="grid gap-4">
      <Field label="Public repository" htmlFor="repo">
        <Input id="repo" name="repo" required placeholder="https://github.com/owner/name" autoComplete="off" spellCheck={false} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Root directory" htmlFor="rootDir" hint="For monorepos, e.g. apps/web">
          <Input id="rootDir" name="rootDir" placeholder="(repository root)" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Branch" htmlFor="branch" hint="Default branch if empty">
          <Input id="branch" name="branch" placeholder="main" autoComplete="off" spellCheck={false} />
        </Field>
      </div>
      <FormError message={state.error} />
      <SubmitButton pending="Importing…">Import and deploy</SubmitButton>
    </form>
  );
}

// --- log viewer ---------------------------------------------------------------

const ANSI_CLASS: Record<string, string> = {
  "1": "font-semibold", "2": "opacity-60",
  "31": "text-[#ff6369]", "32": "text-[#3fb950]", "33": "text-[#f5a524]", "34": "text-[#52a8ff]",
  "35": "text-[#c084fc]", "36": "text-[#5eead4]", "90": "opacity-60", "91": "text-[#ff6369]", "92": "text-[#3fb950]", "93": "text-[#f5a524]",
  "94": "text-[#52a8ff]", "95": "text-[#c084fc]", "96": "text-[#5eead4]",
};

/** Text with ANSI color codes → styled segments. Other escape sequences are dropped; \r keeps the last redraw. */
function toSegments(text: string): { text: string; cls: string }[] {
  const clean = text
    .split("\n")
    .map((line) => line.split("\r").filter((part, i, all) => part !== "" || i === all.length - 1).at(-1) ?? "")
    .join("\n")
    .replace(/\x1b\[[0-9;?]*[A-HJKSTfhlnsu]/g, "");
  const segments: { text: string; cls: string }[] = [];
  let classes: string[] = [];
  for (const part of clean.split(/(\x1b\[[0-9;]*m)/)) {
    const sgr = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (sgr) {
      for (const code of (sgr[1] || "0").split(";")) {
        if (code === "0" || code === "39" || code === "22") classes = [];
        else if (ANSI_CLASS[code]) classes = [...classes.filter((c) => !c.startsWith("text-")), ANSI_CLASS[code]!];
      }
    } else if (part) {
      segments.push({ text: part, cls: classes.join(" ") });
    }
  }
  return segments;
}

export function LogViewer({ deploymentId, initialStatus }: { deploymentId: number; initialStatus: string }) {
  const [log, setLog] = useState("");
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const lastStatus = useRef(initialStatus);

  useEffect(() => {
    const source = new EventSource(`/api/deployments/${deploymentId}/events`);
    source.addEventListener("log", (e) => setLog((prev) => prev + JSON.parse((e as MessageEvent).data)));
    source.addEventListener("status", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { status: string } | null;
      if (d && d.status !== lastStatus.current) {
        lastStatus.current = d.status;
        router.refresh();
      }
    });
    source.onerror = () => source.close();
    return () => source.close();
  }, [deploymentId, router]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [log, follow]);

  const segments = useMemo(() => toSegments(log), [log]);
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-[#0a0a0a] text-[#ededed]">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-[12px] text-white/60">
        <span>Build log</span>
        <div className="flex items-center gap-1">
          {!follow && (
            <button type="button" onClick={() => setFollow(true)} className="rounded px-2 py-1 transition-colors duration-150 hover:bg-white/10 hover:text-white">
              Follow
            </button>
          )}
          <button type="button" onClick={() => navigator.clipboard.writeText(log.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))} className="rounded px-2 py-1 transition-colors duration-150 hover:bg-white/10 hover:text-white">
            Copy
          </button>
          <a
            href={`data:text/plain;charset=utf-8,${encodeURIComponent(log.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))}`}
            download={`deployment-${deploymentId}.log`}
            className="rounded px-2 py-1 transition-colors duration-150 hover:bg-white/10 hover:text-white"
          >
            Download
          </a>
        </div>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="h-[480px] overflow-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-words"
        role="log"
        aria-live="polite"
      >
        {segments.length === 0 ? <span className="opacity-50">Waiting for output…</span> : segments.map((s, i) => <span key={i} className={cx(s.cls)}>{s.text}</span>)}
      </div>
    </div>
  );
}

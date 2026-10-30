"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { importAndDeploy, type ImportState } from "@/app/actions/projects";
import { SubmitButton } from "./form";
import { Field, FormError, Input, NO_AUTOFILL, cx } from "./ui";
import { CARD } from "./page";

/** Import button for one repo in the list. */
export function ImportButton({ repo, installationId }: { repo: string; installationId: number }) {
  const [state, action] = useActionState(importAndDeploy, {} as ImportState);
  return (
    <form action={action} className="grid justify-items-end gap-1">
      <input type="hidden" name="repo" value={repo} />
      <input type="hidden" name="installationId" value={installationId} />
      <SubmitButton pending="Importing…" size="sm" className="w-auto">
        Import
      </SubmitButton>
      {state.error && <p className="max-w-[260px] text-right text-[12px] text-rose">{state.error}</p>}
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
      <div>
        <SubmitButton pending="Importing…" className="w-auto">
          Import and deploy
        </SubmitButton>
      </div>
    </form>
  );
}

// --- log viewer ---------------------------------------------------------------

// The log area is always dark (also in the light theme), so these are fixed colors.
const ANSI_CLASS: Record<string, string> = {
  "1": "font-semibold text-white", "2": "opacity-60",
  "31": "text-[#f2777a]", "32": "text-[#7ccfc2]", "33": "text-[#f2b35b]", "34": "text-[#6c9ef0]",
  "35": "text-[#b4a6f5]", "36": "text-[#7ccfc2]", "90": "opacity-60", "91": "text-[#f2777a]", "92": "text-[#7ccfc2]", "93": "text-[#f2b35b]",
  "94": "text-[#6c9ef0]", "95": "text-[#b4a6f5]", "96": "text-[#7ccfc2]",
};

/** Text with ANSI color codes → styled segments. Other escape sequences are dropped; \r keeps the last redraw. */
export function toSegments(text: string): { text: string; cls: string }[] {
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

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** The dark log area with a bar for following, copying and downloading. */
export function LogPane({ text, live, label, fileName, minHeight = "calc(100dvh - 300px)", toolbar }: { text: string; live: boolean; label: string; fileName: string; minHeight?: string; toolbar?: React.ReactNode }) {
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text, follow]);
  const segments = useMemo(() => toSegments(text), [text]);
  const btn = "h-[26px] rounded-md px-2.5 text-[12px] font-medium text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground";
  return (
    <div className={CARD}>
      <div className="flex items-center gap-3 px-4 py-3 sm:px-5">
        <span className="inline-flex items-center gap-2 text-[13px] text-muted">
          <span className={cx("size-2 rounded-full", live ? "bg-teal [animation:pulse-ring_1.6s_infinite]" : "bg-dim")} />
          {label}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {toolbar}
          {!follow && (
            <button type="button" onClick={() => setFollow(true)} className={btn}>
              Follow
            </button>
          )}
          <button type="button" onClick={() => navigator.clipboard.writeText(stripAnsi(text))} className={btn}>
            Copy
          </button>
          <a href={`data:text/plain;charset=utf-8,${encodeURIComponent(stripAnsi(text))}`} download={fileName} className={cx(btn, "inline-flex items-center")}>
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
        style={{ height: minHeight }}
        className="mx-2.5 mb-2.5 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-code px-4 pb-6 pt-3.5 font-mono text-[12.5px] leading-[1.75] text-[#e9e5df] sm:px-5"
        role="log"
        aria-live="polite"
      >
        {segments.length === 0 ? <span className="opacity-50">Waiting for output…</span> : segments.map((s, i) => <span key={i} className={cx(s.cls)}>{s.text}</span>)}
      </div>
    </div>
  );
}

const DONE = ["ready", "failed", "cancelled"];

export function LogViewer({ deploymentId, initialStatus }: { deploymentId: number; initialStatus: string }) {
  const [log, setLog] = useState("");
  const router = useRouter();
  const lastStatus = useRef(initialStatus);
  const [live, setLive] = useState(!DONE.includes(initialStatus));

  // Until the deployment finishes, a stream that drops or goes quiet (the
  // server pings every 15s) is opened again. Each connection starts with the
  // whole log so far, which replaces what's shown.
  useEffect(() => {
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let failures = 0;
    const reconnect = () => {
      source?.close();
      clearTimeout(watchdog);
      if (!finished && ++failures <= 10) retry = setTimeout(connect, Math.min(1000 * failures, 5000));
    };
    const alive = () => {
      failures = 0;
      clearTimeout(watchdog);
      watchdog = setTimeout(reconnect, 25_000);
    };
    const connect = () => {
      let first = true;
      source = new EventSource(`/api/deployments/${deploymentId}/events`);
      source.addEventListener("ping", alive);
      source.addEventListener("log", (e) => {
        alive();
        const text = JSON.parse((e as MessageEvent).data) as string;
        setLog((prev) => (first ? text : prev + text));
        first = false;
      });
      source.addEventListener("status", (e) => {
        alive();
        const d = JSON.parse((e as MessageEvent).data) as { status: string } | null;
        if (!d) return;
        finished = DONE.includes(d.status);
        if (d.status !== lastStatus.current) {
          lastStatus.current = d.status;
          setLive(!finished);
          router.refresh();
        }
      });
      source.onerror = reconnect;
    };
    connect();
    return () => {
      finished = true;
      clearTimeout(retry);
      clearTimeout(watchdog);
      source?.close();
    };
  }, [deploymentId, router]);

  return <LogPane text={log} live={live} label={live ? "Streaming" : "Build log"} fileName={`deployment-${deploymentId}.log`} />;
}

/** The app's journal, live: the last lines, then new ones as they come. */
export function AppLogs({ slug }: { slug: string }) {
  const [log, setLog] = useState("");
  const [live, setLive] = useState(true);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    const source = new EventSource(`/api/projects/${slug}/logs`);
    source.addEventListener("log", (e) => setLog((prev) => (prev + JSON.parse((e as MessageEvent).data)).slice(-400_000)));
    source.addEventListener("end", () => setLive(false));
    source.onerror = () => {
      setLive(false);
      source.close();
    };
    return () => source.close();
  }, [slug]);
  const shown = filter.trim() ? log.split("\n").filter((l) => l.toLowerCase().includes(filter.trim().toLowerCase())).join("\n") : log;
  return (
    <LogPane
      text={shown}
      live={live}
      label={live ? "Live" : "Stopped (reload to reconnect)"}
      fileName={`${slug}.log`}
      toolbar={<input {...NO_AUTOFILL} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" aria-label="Filter lines" className="mr-2 h-[30px] w-[220px] rounded-lg border border-border-strong bg-transparent px-2.5 text-[13px] outline-none placeholder:text-dim focus:border-accent max-sm:w-[130px]" />}
    />
  );
}

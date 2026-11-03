"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { saveWorkerAction, stopRunAction, type WorkerState } from "@/app/actions/workers";
import type { RunEnd } from "@/app/api/projects/[slug]/run/route";
import { LogPane } from "./deploy";
import { SubmitButton } from "./form";
import { Button, Field, FormError, Input, cx } from "./ui";

const MEMORY = [256, 512, 1024, 2048] as const;

export function WorkerForm({ slug, nodeVersion }: { slug: string; nodeVersion: string }) {
  const [state, action] = useActionState(saveWorkerAction, {} as WorkerState);
  const [memory, setMemory] = useState<number>(512);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.saved) form.current?.reset();
  }, [state]);
  const e = state.errors ?? {};
  return (
    <form ref={form} action={action} className="grid gap-4" data-testid="worker-form">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="memoryMb" value={memory} />
      <div className="grid gap-4 sm:grid-cols-[1fr_1.4fr]">
        <Field label="Name" htmlFor="worker-name" hint="Lowercase, e.g. queue">
          <Input id="worker-name" name="name" placeholder="queue" spellCheck={false} />
          {e.name && <p className="text-[13px] text-rose">{e.name}</p>}
        </Field>
        <Field label="Command" htmlFor="worker-command" hint={`Keeps running from the live release, on Node ${nodeVersion}.`}>
          <Input id="worker-command" name="command" placeholder="node worker.js" spellCheck={false} className="font-mono text-[13px]" />
          {e.command && <p className="text-[13px] text-rose">{e.command}</p>}
        </Field>
      </div>
      <div className="grid gap-1.5">
        <p className="text-[13px] font-medium">Memory limit</p>
        <div className="flex flex-wrap gap-1.5">
          {MEMORY.map((mb) => (
            <button
              key={mb}
              type="button"
              onClick={() => setMemory(mb)}
              className={cx(
                "h-8 border px-3 text-[13px] font-medium transition-colors duration-150",
                memory === mb ? "border-border-strong bg-selected text-foreground" : "border-border text-muted hover:bg-hover hover:text-foreground",
              )}
            >
              {mb < 1024 ? `${mb} MB` : `${mb / 1024} GB`}
            </button>
          ))}
        </div>
        {e.memoryMb && <p className="text-[13px] text-rose">{e.memoryMb}</p>}
      </div>
      <FormError message={e.form} />
      {state.saved && (
        <p className="text-[13px] text-teal">{state.started ? `Saved ${state.saved}. It's running.` : `Saved ${state.saved}. It starts with the project's first deploy.`}</p>
      )}
      <div>
        <SubmitButton pending="Saving…" className="w-auto">
          Save worker
        </SubmitButton>
      </div>
    </form>
  );
}

type Phase = { kind: "idle" } | { kind: "running" } | { kind: "done"; end: RunEnd } | { kind: "error"; message: string };

/** Runs one command in the live release and shows its output as it comes. */
export function RunCommand({ slug, suggestions, deployed }: { slug: string; suggestions: string[]; deployed: boolean }) {
  const [command, setCommand] = useState("");
  const [output, setOutput] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const abort = useRef<AbortController | null>(null);
  const running = phase.kind === "running";

  async function run(text: string) {
    const ctl = new AbortController();
    abort.current = ctl;
    setOutput(`$ ${text}\n`);
    setPhase({ kind: "running" });
    try {
      const res = await fetch(`/api/projects/${slug}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: text }), signal: ctl.signal });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setPhase({ kind: "error", message: body?.error ?? `The panel answered ${res.status}.` });
        return;
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let ended = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const msg = JSON.parse(line) as { log?: string; end?: RunEnd; error?: string };
          if (msg.log) setOutput((o) => o + msg.log);
          if (msg.end) {
            ended = true;
            setPhase({ kind: "done", end: msg.end });
          }
          if (msg.error) {
            ended = true;
            setPhase({ kind: "error", message: msg.error });
          }
        }
      }
      if (!ended) setPhase({ kind: "error", message: "The connection to the panel closed before the command finished." });
    } catch (err) {
      setPhase(ctl.signal.aborted ? { kind: "error", message: "Stopped." } : { kind: "error", message: (err as Error).message });
    } finally {
      abort.current = null;
    }
  }

  function stop() {
    abort.current?.abort();
    // Leaving the stream stops it too; this makes sure, even through a proxy that kept the request open.
    void stopRunAction(slug);
  }

  const label =
    phase.kind === "running"
      ? "Running…"
      : phase.kind === "done"
        ? phase.end.timedOut
          ? "Stopped after an hour"
          : phase.end.code === 0
            ? `Done in ${(phase.end.ms / 1000).toFixed(1)}s`
            : `Failed: exit code ${phase.end.code}`
        : phase.kind === "error"
          ? phase.message
          : "Output";

  return (
    <div className="grid gap-4" data-testid="run-command">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (command.trim() && !running) void run(command.trim());
        }}
      >
        <Input
          aria-label="Command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="npm run migrate"
          spellCheck={false}
          disabled={running || !deployed}
          className="min-w-0 flex-1 font-mono text-[13px]"
        />
        {running ? (
          <Button type="button" variant="danger" onClick={stop}>
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!deployed || !command.trim()}>
            Run
          </Button>
        )}
      </form>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={running || !deployed}
              onClick={() => setCommand(s)}
              className="h-7 border border-border px-2.5 font-mono text-[12px] text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
      )}
      {phase.kind !== "idle" && <LogPane text={output} live={running} label={label} fileName={`${slug}-run.log`} minHeight="min(420px, 60dvh)" />}
    </div>
  );
}

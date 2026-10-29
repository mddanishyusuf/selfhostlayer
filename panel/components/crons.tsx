"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { saveCronAction, type CronState } from "@/app/actions/crons";
import { describeCron } from "@/lib/cron";
import { SubmitButton } from "./form";
import { Field, FormError, Input, cx } from "./ui";

const PRESETS = [
  ["*/5 * * * *", "Every 5 minutes"],
  ["0 * * * *", "Every hour"],
  ["0 3 * * *", "Every day at 03:00"],
  ["0 8 * * 1-5", "Weekdays at 08:00"],
  ["@weekly", "Every week"],
] as const;

export function CronForm({ slug, nodeVersion }: { slug: string; nodeVersion: string }) {
  const [state, action] = useActionState(saveCronAction, {} as CronState);
  const [schedule, setSchedule] = useState("0 * * * *");
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.saved) form.current?.reset();
  }, [state]);
  const e = state.errors ?? {};
  return (
    <form ref={form} action={action} className="grid gap-4">
      <input type="hidden" name="slug" value={slug} />
      <div className="grid gap-4 sm:grid-cols-[1fr_1.4fr]">
        <Field label="Name" htmlFor="name" hint="Lowercase, e.g. sync-orders">
          <Input id="name" name="name" placeholder="sync-orders" autoComplete="off" spellCheck={false} />
          {e.name && <p className="text-[13px] text-rose">{e.name}</p>}
        </Field>
        <Field label="Schedule" htmlFor="schedule" hint={`${describeSafe(schedule)} · server time (UTC)`}>
          <Input id="schedule" name="schedule" value={schedule} onChange={(ev) => setSchedule(ev.target.value)} spellCheck={false} className="font-mono text-[13px]" />
          {e.schedule && <p className="text-[13px] text-rose">{e.schedule}</p>}
        </Field>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setSchedule(value)}
            className={cx(
              "h-7 rounded-md border px-2.5 text-[12.5px] font-medium transition-colors duration-150",
              schedule === value ? "border-border-strong bg-selected text-foreground" : "border-border text-muted hover:bg-hover hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <Field label="Command" htmlFor="command" hint={`Runs in the live release as the app's user, with its env vars, on Node ${nodeVersion}.`}>
        <Input id="command" name="command" placeholder="node scripts/sync.js" spellCheck={false} className="font-mono text-[13px]" />
        {e.command && <p className="text-[13px] text-rose">{e.command}</p>}
      </Field>
      <input type="hidden" name="timeoutSec" value="3600" />
      <FormError message={e.form} />
      {state.saved && <p className="text-[13px] text-teal">Saved {state.saved}. Its timer is running on the server.</p>}
      <div>
        <SubmitButton pending="Saving…" className="w-auto">
          Save job
        </SubmitButton>
      </div>
    </form>
  );
}

function describeSafe(schedule: string): string {
  try {
    return describeCron(schedule);
  } catch {
    return schedule;
  }
}

"use client";

import { useActionState, useState } from "react";
import { setBuildSlotsAction, type BuildSlotsState } from "@/app/actions/builds";
import { SubmitButton } from "./form";
import { FormError, cx } from "./ui";

/** How many projects may build at the same time; the rest wait in line. */
export function BuildSlotsForm({ current }: { current: number }) {
  const [slots, setSlots] = useState(current);
  const [state, action] = useActionState(setBuildSlotsAction, {} as BuildSlotsState);
  return (
    <form action={action} className="grid gap-3" data-testid="build-slots">
      <input type="hidden" name="slots" value={slots} />
      <div className="inline-flex gap-0.5 justify-self-start rounded-lg border border-border-strong p-[3px]" role="radiogroup" aria-label="Builds at the same time">
        {[1, 2, 3, 4].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={slots === n}
            onClick={() => setSlots(n)}
            className={cx("h-7 min-w-9 rounded-md px-3 text-[13px] font-medium tabular-nums transition-colors duration-150", slots === n ? "bg-selected text-foreground" : "text-muted hover:text-foreground")}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending="Saving…" variant="secondary" size="sm" className="w-auto">
          Save
        </SubmitButton>
        {state.ok && <span className="text-[13px] text-teal">{state.ok}</span>}
      </div>
      <FormError message={state.error} />
    </form>
  );
}

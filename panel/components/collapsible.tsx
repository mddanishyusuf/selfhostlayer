"use client";

import { ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Icon } from "./icon";
import { Button, cx } from "./ui";
import { CARD } from "./page";

/**
 * A summary row that expands in place: a project's domains, an engine's
 * databases. `side` sits next to the Manage/Hide button.
 */
export function Collapsible({
  lead,
  title,
  sub,
  side,
  children,
  defaultOpen = false,
  openLabel = "Hide",
  closedLabel = "Manage",
  testId,
}: {
  lead: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  side?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  openLabel?: string;
  closedLabel?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={CARD} data-testid={testId} data-open={open ? "true" : "false"}>
      <div className={cx("grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3.5 px-3.5 py-4 transition-colors duration-150 hover:bg-hover", open && "bg-hover")}>
        {lead}
        <div className="grid min-w-0 gap-0.5">
          <div className="flex min-w-0 items-center gap-2 text-[15px] font-semibold">{title}</div>
          {sub && <div className="flex min-w-0 items-center gap-1.5 truncate whitespace-nowrap text-[12px] text-muted">{sub}</div>}
        </div>
        <div className="flex items-center gap-2.5">
          {side}
          <Button variant="secondary" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? openLabel : closedLabel}
            <Icon icon={ChevronDownIcon} size={14} strokeWidth={2} className={cx("transition-transform duration-150", open && "rotate-180")} />
          </Button>
        </div>
      </div>
      {open && <div>{children}</div>}
    </section>
  );
}

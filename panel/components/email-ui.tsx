// What Email's pages share: status pills, rates, dates, and the setup
// checklist a new brand shows until it can send.
import { CircleCheckIcon, CircleIcon } from "lucide-react";
import Link from "next/link";
import { Icon } from "./icon";
import { CARD } from "./page";
import { cx } from "./ui";

// AgentOS's pills: green outlined; gold, red and gray filled.
const TONES = {
  green: "border-ok-line text-ok",
  gold: "border-transparent bg-warn-soft text-warn",
  red: "border-transparent bg-err-soft text-err",
  gray: "border-transparent bg-pill text-pill-text",
} as const;

/** An AgentOS pill in a status's color. */
export function StatusPill({ status, testId }: { status: string; testId?: string }) {
  const tone: keyof typeof TONES = ["sent", "delivered", "verified", "subscribed", "active", "done"].includes(status)
    ? "green"
    : ["sending", "scheduled", "queued", "pending", "unconfirmed", "paused", "deferred"].includes(status)
      ? "gold"
      : ["failed", "bounced", "complained", "cancelled", "exited"].includes(status)
        ? "red"
        : "gray";
  return (
    <span className={cx("inline-flex items-center whitespace-nowrap border px-[7px] py-px text-[11px]", TONES[tone])} data-testid={testId}>
      {status[0]!.toUpperCase() + status.slice(1)}
    </span>
  );
}

export const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : "–");

/** 31 Oct, 21:25 (this year), or with the year. */
export function when(at: number | null | undefined): string {
  if (!at) return "–";
  const d = new Date(at);
  const same = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", ...(same ? {} : { year: "numeric" }), hour: "2-digit", minute: "2-digit" });
}

/** What a brand still needs before it sends, with links; nothing once it's all done. */
export function SetupChecklist({ steps }: { steps: { label: string; done: boolean; href: string }[] }) {
  if (steps.every((s) => s.done)) return null;
  return (
    <section className={CARD} data-testid="email-setup">
      <div className="px-3.5 pb-2.5 pt-3.5">
        <h2 className="text-[14px] font-bold">Before it can send</h2>
        <p className="text-[12px] text-muted">
          {steps.filter((s) => s.done).length} of {steps.length} done
        </p>
      </div>
      {steps.map((s) => (
        <Link key={s.label} href={s.href} className="flex items-center gap-2.5 border-t border-border-soft px-3.5 py-2.5 text-[13px] transition-colors hover:bg-hover">
          <Icon icon={s.done ? CircleCheckIcon : CircleIcon} size={15} className={s.done ? "text-teal" : "text-dim"} />
          <span className={cx("flex-1", s.done && "text-muted line-through")}>{s.label}</span>
        </Link>
      ))}
    </section>
  );
}

import {
  AlertCircleIcon,
  Atom01Icon,
  Compass01Icon,
  CubeIcon,
  Diamond01Icon,
  Flower01Icon,
  Globe02Icon,
  Idea01Icon,
  Layers01Icon,
  Leaf01Icon,
  PuzzleIcon,
  Rocket01Icon,
  StarIcon,
  Sun03Icon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import type { ComponentProps, ReactNode } from "react";
import { Icon } from "./icon";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
export { cx };

const focus = "outline-none focus-visible:ring-2 focus-visible:ring-lavender/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background";

const VARIANTS = {
  primary: "border border-inverse bg-inverse text-inverse-fg hover:opacity-90",
  secondary: "border border-border-strong text-foreground hover:bg-hover",
  ghost: "border border-transparent text-muted hover:bg-hover hover:text-foreground",
  danger: "border border-rose bg-rose text-on-rose hover:opacity-90",
} as const;

/** A pill button. size "sm" for row actions. */
export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: keyof typeof VARIANTS; size?: "sm" | "md" }) {
  return (
    <button
      className={cx(
        "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-semibold transition-[background-color,opacity] duration-150 ease-out disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "h-7 px-3 text-[12.5px]" : "h-[34px] px-3.5 text-[13px]",
        focus,
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}

export const buttonClass = (variant: keyof typeof VARIANTS = "primary", size: "sm" | "md" = "md") =>
  cx(
    "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-semibold transition-[background-color,opacity] duration-150 ease-out",
    size === "sm" ? "h-7 px-3 text-[12.5px]" : "h-[34px] px-3.5 text-[13px]",
    focus,
    VARIANTS[variant],
  );

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cx(
        "h-[38px] w-full rounded-md border border-border-strong bg-transparent px-3 text-sm transition-[border-color,box-shadow] duration-150 placeholder:text-dim focus:border-lavender focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--lavender)_22%,transparent)]",
        "outline-none aria-invalid:border-rose",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cx("select-pill h-[38px] w-full rounded-md border border-border-strong bg-transparent pl-3 pr-8 text-sm outline-none focus:border-lavender", className)}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cx("text-[13px] font-medium text-foreground", className)} {...props} />;
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-[12.5px] text-dim">{hint}</p>}
    </div>
  );
}

/** A plain bordered block. The design avoids cards: prefer sections and rows. */
export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("rounded-xl border border-border", className)} {...props} />;
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg bg-err-subtle px-3 py-2 text-[13px] text-rose">
      <Icon icon={AlertCircleIcon} size={15} className="mt-0.5" />
      {message}
    </p>
  );
}

export function Logo({ withName = true }: { withName?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="grid size-[30px] place-items-center rounded-lg bg-foreground text-background">
        <Icon icon={Layers01Icon} size={17} strokeWidth={2} />
      </span>
      {withName && <span className="text-[15px] font-semibold tracking-tight">Self Host Layer</span>}
    </span>
  );
}

export function StatusDot({ status, pulse }: { status: "ok" | "warn" | "err" | "idle"; pulse?: boolean }) {
  const color = { ok: "bg-teal", warn: "bg-gold", err: "bg-rose", idle: "bg-dim" }[status];
  return (
    <span
      className={cx("inline-block size-2 shrink-0 rounded-full", color, pulse && "shadow-[0_0_0_0_color-mix(in_srgb,var(--gold)_60%,transparent)] [animation:pulse-ring_1.6s_infinite]")}
      aria-hidden
    />
  );
}

/** Small rounded label: a state ("Building", "Live") or a version. */
export function Pill({ children, outline, className }: { children: ReactNode; outline?: boolean; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex h-[22px] items-center whitespace-nowrap rounded-md px-2 text-[12px] font-medium",
        outline ? "border border-border-strong text-muted" : "bg-pill text-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      className={cx("block rounded-md bg-[linear-gradient(90deg,var(--hover)_25%,var(--selected)_50%,var(--hover)_75%)] bg-[length:200%_100%] [animation:shimmer_1.5s_linear_infinite]", className)}
    />
  );
}

/** A project's icon in a tinted square; the color is stable per index. */
export const MARK_COLORS = ["lavender", "coral", "teal", "blue", "gold", "rose", "foreground"] as const;
const MARK_CLASS: Record<(typeof MARK_COLORS)[number], string> = {
  lavender: "bg-lavender/18 text-lavender",
  coral: "bg-coral/18 text-coral",
  teal: "bg-teal/18 text-teal",
  blue: "bg-blue/18 text-blue",
  gold: "bg-gold/18 text-gold",
  rose: "bg-rose/18 text-rose",
  foreground: "bg-foreground/12 text-foreground",
};
/** Picked by index like the colors, so the first 14 projects all look different. */
const MARK_ICONS = [Rocket01Icon, Globe02Icon, CubeIcon, Layers01Icon, Leaf01Icon, ZapIcon, StarIcon, Diamond01Icon, Sun03Icon, Compass01Icon, PuzzleIcon, Atom01Icon, Idea01Icon, Flower01Icon];

/** A project's mark: its icon on its color. `name` is the project it stands for (the row says it in words). */
export function Mark({ index, size = "md" }: { name: string; index: number; size?: "sm" | "md" }) {
  return (
    <span
      className={cx("grid shrink-0 place-items-center", size === "sm" ? "size-[30px] rounded-[9px]" : "size-10 rounded-[11px]", MARK_CLASS[MARK_COLORS[Math.abs(index) % MARK_COLORS.length]!])}
      aria-hidden
    >
      <Icon icon={MARK_ICONS[Math.abs(index) % MARK_ICONS.length]!} size={size === "sm" ? 16 : 20} strokeWidth={1.8} />
    </span>
  );
}

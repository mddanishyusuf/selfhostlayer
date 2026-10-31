import { CircleAlertIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Icon } from "./icon";
import { stackLogo } from "./stack-logos";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
export { cx };

const focus = "outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background";

// As AgentOS: the main button blue and bold, the others a line with no fill, danger in red.
const VARIANTS = {
  primary: "border border-accent bg-accent font-bold text-white hover:brightness-110",
  secondary: "border border-border bg-transparent text-foreground hover:border-btn-hover-line hover:bg-btn-hover",
  ghost: "border border-transparent text-muted hover:bg-btn-hover hover:text-foreground",
  danger: "border border-danger-line bg-transparent text-rose hover:bg-btn-hover",
} as const;

const SIZES = { sm: "h-[26px] px-[9px] text-[12px]", md: "h-[35px] px-[13px] text-[14px]" } as const;

/** A button: the main one blue, the others outlined. size "sm" for row actions. */
export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: keyof typeof VARIANTS; size?: "sm" | "md" }) {
  return (
    <button
      className={cx(
        "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap transition-[background-color,border-color,filter] duration-150 ease-out disabled:pointer-events-none disabled:opacity-50",
        SIZES[size],
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
    "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap transition-[background-color,border-color,filter] duration-150 ease-out",
    SIZES[size],
    focus,
    VARIANTS[variant],
  );

/** Keeps the browser's autofill and password managers out of a field. */
export const NO_AUTOFILL = { autoComplete: "off", "data-1p-ignore": "", "data-lpignore": "true", "data-bwignore": "", "data-form-type": "other" } as const;

/** Nothing gets filled in by the browser unless the field says what it is (the panel's own login does). */
export function Input({ className, ...props }: ComponentProps<"input">) {
  const own = props.autoComplete !== undefined && props.autoComplete !== "off";
  return (
    <input
      className={cx(
        "h-[39px] w-full border border-border bg-field px-2.5 transition-[border-color,box-shadow] duration-150 placeholder:text-placeholder focus:border-accent focus:shadow-focus",
        "outline-none aria-invalid:border-rose",
        className,
      )}
      {...(own ? {} : NO_AUTOFILL)}
      {...props}
    />
  );
}

/**
 * A secret that isn't the panel's own login (an env value, an API key): a text
 * field drawn as dots. As type=password, browsers take the form for a login
 * and fill in your saved email and password, whatever autocomplete says.
 */
export function SecretInput({ reveal = false, className, ...props }: Omit<ComponentProps<"input">, "type"> & { reveal?: boolean }) {
  return <Input {...props} type="text" spellCheck={false} autoCapitalize="off" autoCorrect="off" className={cx(!reveal && "[-webkit-text-security:disc]", className)} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cx("select-pill h-[39px] w-full border border-border bg-field pl-2.5 pr-8 outline-none focus:border-accent focus:shadow-focus", className)}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cx("font-bold text-foreground", className)} {...props} />;
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid content-start gap-[5px]">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-[12px] text-muted">{hint}</p>}
    </div>
  );
}

/** A card on the page. Prefer Section, which adds a title. */
export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("border border-border bg-card", className)} {...props} />;
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="flex items-start gap-2 bg-err-subtle px-2.5 py-2 text-[12px] text-rose">
      <Icon icon={CircleAlertIcon} size={15} className="mt-0.5" />
      {message}
    </p>
  );
}

/**
 * The logo's four bars (design/logo/icon.svg): two L's turned into each
 * other, on no tile, in the text color (black, or near-white in the dark
 * theme), each bar a step lighter going round.
 */
const LOGO_BARS = [
  { x: 4, y: 4, width: 17.4, height: 5, opacity: 1 },
  { x: 23, y: 4, width: 5, height: 17.4, opacity: 0.72 },
  { x: 10.6, y: 23, width: 17.4, height: 5, opacity: 0.48 },
  { x: 4, y: 10.6, width: 5, height: 17.4, opacity: 0.28 },
];

export function LogoMark({ size = 22, className = "size-[30px] text-foreground" }: { size?: number; className?: string }) {
  return (
    <span className={cx("grid shrink-0 place-items-center", className)} aria-hidden>
      <svg viewBox="3 3 26 26" width={size} height={size} fill="currentColor">
        {LOGO_BARS.map(({ opacity, ...bar }) => (
          <rect key={opacity} {...bar} rx="1.2" fillOpacity={opacity} />
        ))}
      </svg>
    </span>
  );
}

export function Logo({ withName = true }: { withName?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark />
      {withName && <span className="text-[15px] font-bold">Self Host Layer</span>}
    </span>
  );
}

export function StatusDot({ status, pulse }: { status: "ok" | "warn" | "err" | "idle"; pulse?: boolean }) {
  const color = { ok: "bg-ok-dot", warn: "bg-warn-dot", err: "bg-err-dot", idle: "bg-dim" }[status];
  return (
    <span
      className={cx("inline-block size-2 shrink-0 rounded-full", color, pulse && "shadow-[0_0_0_0_color-mix(in_srgb,var(--warn-dot)_60%,transparent)] [animation:pulse-ring_1.6s_infinite]")}
      aria-hidden
    />
  );
}

/** A small label, as AgentOS's pills: a state ("Building", "Live") or a version. */
export function Pill({ children, outline, className }: { children: ReactNode; outline?: boolean; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-[5px] whitespace-nowrap border px-[9px] py-px text-[11px]",
        outline ? "border-border text-muted" : "border-transparent bg-pill text-pill-text",
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
      className={cx("block bg-[linear-gradient(90deg,var(--hover)_25%,var(--selected)_50%,var(--hover)_75%)] bg-[length:200%_100%] [animation:shimmer_1.5s_linear_infinite]", className)}
    />
  );
}

/** A project's own mark on the Projects page: its shape grid (lib/avatar.ts), with its stack named on hover. */
export function ShapeMark({ src, framework, size = "md" }: { src: string; framework: string; size?: "sm" | "md" }) {
  return <img src={src} alt="" title={stackLogo(framework).title} className={cx("shrink-0", size === "sm" ? "size-7" : "size-9")} />;
}

/** A project's mark: the logo of its stack (its detected framework) on AgentOS's project tile, white in dark and black in light. Bare in lists: no tile. */
export function Mark({ framework, size = "md", bare }: { framework: string; size?: "sm" | "md"; bare?: boolean }) {
  const logo = stackLogo(framework);
  const px = size === "sm" ? 14 : 18;
  if (bare) {
    return (
      <svg role="img" aria-label={logo.title} viewBox="0 0 24 24" width={20} height={20} fill="currentColor" className="shrink-0 text-foreground">
        <title>{logo.title}</title>
        <path d={logo.path} />
      </svg>
    );
  }
  return (
    <span
      role="img"
      aria-label={logo.title}
      title={logo.title}
      className={cx("grid shrink-0 place-items-center bg-icon-tile text-icon-tile-fg", size === "sm" ? "size-7" : "size-9")}
    >
      <svg viewBox="0 0 24 24" width={px} height={px} fill="currentColor" aria-hidden>
        <path d={logo.path} />
      </svg>
    </span>
  );
}

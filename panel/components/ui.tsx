import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import type { ComponentProps, ReactNode } from "react";
import { Icon } from "./icon";
import { stackLogo } from "./stack-logos";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
export { cx };

const focus = "outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background";

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

/** Keeps the browser's autofill and password managers out of a field. */
export const NO_AUTOFILL = { autoComplete: "off", "data-1p-ignore": "", "data-lpignore": "true", "data-bwignore": "", "data-form-type": "other" } as const;

/** Nothing gets filled in by the browser unless the field says what it is (the panel's own login does). */
export function Input({ className, ...props }: ComponentProps<"input">) {
  const own = props.autoComplete !== undefined && props.autoComplete !== "off";
  return (
    <input
      className={cx(
        "h-[38px] w-full rounded-md border border-border bg-field px-3 text-sm transition-[border-color,box-shadow] duration-150 placeholder:text-dim focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)]",
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
      className={cx("select-pill h-[38px] w-full rounded-md border border-border bg-field pl-3 pr-8 text-sm outline-none focus:border-accent", className)}
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

/** The logo (design/logo): an L, a violet app standing on an orange layer, your server. */
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

export function LogoMark() {
  return (
    <span className="grid size-[30px] shrink-0 place-items-center text-foreground" aria-hidden>
      <svg viewBox="3 3 26 26" className="size-[22px]" fill="currentColor">
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

/** A project's mark: the logo of its stack (its detected framework), in one color for every project. Bare in lists: no tile. */
export function Mark({ framework, size = "md", bare }: { framework: string; size?: "sm" | "md"; bare?: boolean }) {
  const logo = stackLogo(framework);
  const px = size === "sm" ? 15 : 19;
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
      className={cx("grid shrink-0 place-items-center border border-border bg-foreground/[0.04] text-foreground", size === "sm" ? "size-[30px] rounded-[9px]" : "size-10 rounded-[11px]")}
    >
      <svg viewBox="0 0 24 24" width={px} height={px} fill="currentColor" aria-hidden>
        <path d={logo.path} />
      </svg>
    </span>
  );
}

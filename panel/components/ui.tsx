import { CircleAlert, Layers } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
export { cx };

const focus = "outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background";

export function Button({
  variant = "primary",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: "primary" | "secondary" | "ghost" }) {
  return (
    <button
      className={cx(
        "inline-flex h-9 select-none items-center justify-center gap-2 rounded-full px-4 text-sm font-bold transition-colors duration-150 ease-out disabled:pointer-events-none disabled:opacity-50",
        focus,
        variant === "primary" && "bg-inverse text-inverse-fg hover:opacity-90",
        variant === "secondary" && "border border-border-strong bg-background hover:bg-hover",
        variant === "ghost" && "text-muted hover:bg-hover hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cx(
        "h-10 w-full rounded-md border border-border-strong bg-background px-3 text-sm transition-colors duration-150 placeholder:text-muted/70 focus:border-accent",
        focus,
        "aria-invalid:border-err",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cx("text-[13px] font-medium text-foreground", className)} {...props} />;
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-[13px] text-muted">{hint}</p>}
    </div>
  );
}

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("rounded-2xl border border-border bg-background", className)} {...props} />;
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="flex items-start gap-2 rounded-md bg-err-subtle px-3 py-2 text-[13px] text-err">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {message}
    </p>
  );
}

export function Logo({ withName = true }: { withName?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="grid size-7 place-items-center rounded-md bg-inverse text-inverse-fg">
        <Layers className="size-4" strokeWidth={2.25} aria-hidden />
      </span>
      {withName && <span className="text-[15px] font-semibold tracking-tight">Self Host Layer</span>}
    </span>
  );
}

export function StatusDot({ status }: { status: "ok" | "warn" | "err" | "idle" }) {
  const color = { ok: "bg-ok", warn: "bg-warn", err: "bg-err", idle: "bg-muted/50" }[status];
  return <span className={cx("inline-block size-2 shrink-0 rounded-full", color)} aria-hidden />;
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      className={cx("block rounded-md bg-[linear-gradient(90deg,var(--subtle)_25%,var(--hover)_50%,var(--subtle)_75%)] bg-[length:200%_100%] [animation:shimmer_1.5s_linear_infinite]", className)}
    />
  );
}

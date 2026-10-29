import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "./ui";

/**
 * The sticky bar at the top of every page, like X's column headers: an
 * optional back arrow, the title (and a line under it), actions on the right.
 */
export function PageHeader({ title, subtitle, back, actions }: { title: ReactNode; subtitle?: ReactNode; back?: string; actions?: ReactNode }) {
  return (
    <header className="sticky top-14 z-10 border-b border-border bg-background/85 backdrop-blur-md md:top-0">
      <div className="flex min-h-[57px] items-center gap-4 px-4 py-2 sm:px-6">
        {back && (
          <Link href={back} aria-label="Back" className="-ml-2 grid size-9 shrink-0 place-items-center rounded-full transition-colors duration-150 hover:bg-hover">
            <ArrowLeft className="size-5" aria-hidden />
          </Link>
        )}
        <div className="grid min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold leading-tight tracking-tight">{title}</h1>
          {subtitle && <p className="truncate text-[13px] text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("grid gap-8 px-4 py-6 sm:px-6", className)}>{children}</div>;
}

export function Section({ title, aside, children, description }: { title: ReactNode; aside?: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <div className="flex items-end justify-between gap-4">
        <div className="grid gap-0.5">
          <h2 className="text-[17px] font-bold tracking-tight">{title}</h2>
          {description && <p className="text-[13px] text-muted">{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A pill link, like X's secondary buttons. */
export function PillLink({ href, children, external, primary }: { href: string; children: ReactNode; external?: boolean; primary?: boolean }) {
  const className = cx(
    "inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-sm font-bold transition-colors duration-150",
    primary ? "bg-inverse text-inverse-fg hover:opacity-90" : "border border-border-strong hover:bg-hover",
  );
  return external ? (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  ) : (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

/** Rows separated by lines, edge to edge: lists look like X's timeline. */
export function RowList({ children, className, ...props }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("divide-y divide-border overflow-hidden rounded-2xl border border-border", className)} {...props}>
      {children}
    </div>
  );
}

/** A section that doesn't exist yet: says what it will be. */
export function ComingSoon({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-3 rounded-2xl border border-dashed border-border-strong px-6 py-14 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-subtle text-muted">{icon}</span>
      <p className="text-[17px] font-bold">{title}</p>
      <div className="max-w-[440px] text-[14px] text-muted">{children}</div>
      <span className="rounded-full border border-border-strong px-3 py-1 text-[12px] font-bold text-muted">Coming soon</span>
    </div>
  );
}

// Page building blocks for the line-based layout: full-width sections and rows
// separated by 1px lines, no cards.
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./icon";
import { buttonClass, cx } from "./ui";

/**
 * The sticky bar at the top of every page: optional back arrow, a title with
 * an optional dimmed second part ("piqo / Deployments"), quiet meta text and
 * actions on the right. 60px tall, so its line meets the sidebar's.
 */
export function PageHeader({ title, crumb, back, meta, subtitle, actions }: { title: ReactNode; crumb?: ReactNode; back?: string; meta?: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  const side = meta ?? subtitle;
  return (
    <header className="sticky top-14 z-10 flex h-[60px] items-center gap-3.5 border-b border-border bg-background/90 px-4 backdrop-blur-md sm:px-7 md:top-0">
      {back && (
        <Link href={back} aria-label="Back" className="-ml-1.5 grid size-8 shrink-0 place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground">
          <Icon icon={ArrowLeft01Icon} size={18} />
        </Link>
      )}
      <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">
        {title}
        {crumb && (
          <>
            <span className="mx-1.5 font-normal text-dim">/</span>
            <span className="font-medium text-muted">{crumb}</span>
          </>
        )}
      </h1>
      {side && <span className="ml-auto hidden truncate whitespace-nowrap text-[13px] text-dim lg:block">{side}</span>}
      {actions && <div className={cx("flex shrink-0 items-center gap-2", side ? "ml-auto lg:ml-2" : "ml-auto")}>{actions}</div>}
    </header>
  );
}

const TONE = { gold: "text-gold", ok: "text-teal", err: "text-rose", lav: "text-lavender" } as const;

/** One status line under the header: a colored lead word, then plain text. */
export function Notice({ lead, tone = "gold", children }: { lead: ReactNode; tone?: keyof typeof TONE; children: ReactNode }) {
  return (
    <div className="border-b border-border px-4 py-4 text-[15px] text-muted sm:px-7" data-testid="notice">
      <b className={cx("mr-1.5 font-medium", TONE[tone])}>{lead}</b>
      {children}
    </div>
  );
}

/** A full-width band with a title; lists inside run edge to edge. */
export function Section({ title, description, aside, children, className }: { title?: ReactNode; description?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("border-b border-border", className)}>
      {(title || aside) && (
        <div className="flex items-end justify-between gap-4 px-4 pb-3.5 pt-[22px] sm:px-7">
          <div className="grid gap-0.5">
            {title && <h2 className="flex items-center gap-2 text-[15px] font-semibold">{title}</h2>}
            {description && <p className="text-[13px] text-muted">{description}</p>}
          </div>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/** Padding for non-list content inside a Section. */
export function SectionBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("px-4 pb-6 sm:px-7", className)}>{children}</div>;
}

/** Settings layout: what it is on the left, the controls on the right. */
export function SettingsRow({ title, description, children, id }: { title: ReactNode; description?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <div id={id} className="grid gap-x-14 gap-y-4 border-b border-border px-4 py-6 sm:px-7 xl:grid-cols-[300px_minmax(0,1fr)]">
      <div>
        <h3 className="text-[15px] font-semibold">{title}</h3>
        {description && <p className="mt-1 max-w-[300px] text-[13px] text-muted max-xl:max-w-none">{description}</p>}
      </div>
      <div className="grid max-w-[680px] content-start gap-4">{children}</div>
    </div>
  );
}

/** Label/value lines. inset: inside a SettingsRow (no side padding). flush: no line above (something else draws it). */
export function KeyValues({ items, inset, flush }: { items: [ReactNode, ReactNode][]; inset?: boolean; flush?: boolean }) {
  return (
    <div
      className={cx(
        "grid content-start",
        inset ? "grid-cols-[130px_minmax(0,1fr)] border-b border-border" : "grid-cols-[110px_minmax(0,1fr)] sm:grid-cols-[160px_minmax(0,1fr)]",
        !inset && !flush && "border-t border-border",
      )}
    >
      {items.map(([k, v], i) => {
        const last = i === items.length - 1;
        const cell = cx("min-w-0 text-sm", !last && "border-b border-border", inset ? "py-[11px]" : "px-4 py-[13px] sm:px-7");
        return [
          <div key={`k${i}`} className={cx(cell, "text-dim")}>
            {k}
          </div>,
          <div key={`v${i}`} className={cell}>
            {v}
          </div>,
        ];
      })}
    </div>
  );
}

export interface Stat {
  label: ReactNode;
  value: ReactNode;
  small?: ReactNode;
  detail?: ReactNode;
}

/** A strip of numbers separated by vertical lines. */
export function Stats({ items }: { items: Stat[] }) {
  return (
    <div className={cx("grid grid-cols-2 border-b border-border", items.length >= 5 ? "lg:grid-cols-5" : items.length === 3 ? "lg:grid-cols-3" : items.length === 2 ? "lg:grid-cols-2" : "lg:grid-cols-4")}>
      {items.map((s, i) => (
        <div key={i} className="grid min-w-0 gap-1 border-b border-r border-border px-4 py-4 even:border-r-0 sm:px-7 lg:border-b-0 lg:py-[18px] lg:even:border-r lg:last:border-r-0">
          <span className="text-[13px] text-dim">{s.label}</span>
          <span className="truncate whitespace-nowrap text-[22px] font-semibold tracking-tight tabular-nums">
            {s.value}
            {s.small && <small className="ml-1 text-[13px] font-normal text-muted">{s.small}</small>}
          </span>
          {s.detail && <span className="truncate text-[12.5px] text-muted">{s.detail}</span>}
        </div>
      ))}
    </div>
  );
}

/** Underline tabs that are links (filters live in the URL). */
export function Tabs({ items }: { items: { href: string; label: ReactNode; count?: number; active: boolean }[] }) {
  return (
    <nav className="flex gap-[26px] overflow-x-auto border-b border-border px-4 sm:px-7" aria-label="Filter">
      {items.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.active ? "page" : undefined}
          className={cx(
            "whitespace-nowrap border-b-2 pb-3 pt-3.5 font-medium transition-colors duration-150",
            t.active ? "border-foreground text-foreground" : "border-transparent text-muted hover:text-foreground",
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 tabular-nums text-dim">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** Column labels for a list. Columns are a grid-template-columns value. */
export function TableHead({ columns, children }: { columns: string; children: ReactNode }) {
  return (
    <div className="hidden h-10 items-center gap-x-5 border-b border-t border-border px-7 text-[13px] text-dim md:grid [section>&:first-child]:border-t-0" style={{ gridTemplateColumns: columns }}>
      {children}
    </div>
  );
}

/** One row of a list. On phones the columns wrap instead of squeezing. */
export function TableRow({ columns, href, highlight, children, className, ...rest }: { columns: string; href?: string; highlight?: boolean; children: ReactNode; className?: string } & Record<`data-${string}`, string | undefined>) {
  const cls = cx(
    "relative flex min-h-[60px] flex-wrap items-center gap-x-3.5 gap-y-1.5 border-b border-border px-4 py-2.5 text-[14.5px] transition-colors duration-150 last:border-b-0 md:grid md:gap-x-5 md:px-7",
    highlight && "bg-selected",
    href && "hover:bg-hover",
    className,
  );
  const style = { gridTemplateColumns: columns } as CSSProperties;
  return href ? (
    <Link href={href} className={cls} style={style} {...rest}>
      {children}
    </Link>
  ) : (
    <div className={cls} style={style} {...rest}>
      {children}
    </div>
  );
}

/** A row without columns: a leading icon, a title and a detail line, things on the right. */
export function ListRow({
  lead,
  title,
  sub,
  side,
  href,
  highlight,
  className,
  children,
  indent,
  ...rest
}: {
  lead?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  side?: ReactNode;
  href?: string;
  highlight?: boolean;
  className?: string;
  children?: ReactNode;
  indent?: boolean;
} & Record<`data-${string}`, string | undefined>) {
  const body = (
    <>
      {lead}
      <div className="grid min-w-0 gap-0.5">
        <div className="flex min-w-0 items-center gap-2 text-[15px] font-semibold">{title}</div>
        {sub && <div className="flex min-w-0 items-center gap-1.5 truncate whitespace-nowrap text-[13px] text-muted">{sub}</div>}
      </div>
      {side ? <div className="flex items-center gap-2.5">{side}</div> : <span />}
      {children}
    </>
  );
  const cls = cx(
    "relative grid items-center gap-x-3.5 border-t border-border py-3.5 transition-colors duration-150 [section>&:first-child]:border-t-0",
    lead ? "grid-cols-[auto_minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]",
    indent ? "pl-4 pr-4 sm:pr-7 md:pl-[82px]" : "px-4 sm:px-7",
    highlight && "bg-selected",
    href && "hover:bg-hover",
    className,
  );
  return href ? (
    <Link href={href} className={cls} {...rest}>
      {body}
    </Link>
  ) : (
    <div className={cls} {...rest}>
      {body}
    </div>
  );
}

/** A round tinted icon at the start of a row. */
export function RowIcon({ children, tone = "dim" }: { children: ReactNode; tone?: "ok" | "warn" | "err" | "dim" | "lav" | "blue" | "coral" }) {
  const cls = {
    ok: "bg-teal/14 text-teal",
    warn: "bg-gold/14 text-gold",
    err: "bg-rose/14 text-rose",
    dim: "bg-foreground/7 text-muted",
    lav: "bg-lavender/16 text-lavender",
    blue: "bg-blue/16 text-blue",
    coral: "bg-coral/16 text-coral",
  }[tone];
  return <span className={cx("grid size-9 shrink-0 place-items-center rounded-full", cls)}>{children}</span>;
}

/** A square tinted icon for engines and integrations. */
export function TileIcon({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "lav" | "blue" | "coral" | "teal" | "gold" | "rose" }) {
  const cls = {
    dim: "bg-foreground/7 text-muted",
    lav: "bg-lavender/16 text-lavender",
    blue: "bg-blue/16 text-blue",
    coral: "bg-coral/16 text-coral",
    teal: "bg-teal/16 text-teal",
    gold: "bg-gold/16 text-gold",
    rose: "bg-rose/16 text-rose",
  }[tone];
  return <span className={cx("grid size-10 shrink-0 place-items-center rounded-[11px]", cls)}>{children}</span>;
}

/** Separator dot inside detail lines. */
export const Dot = () => <span className="text-dim">·</span>;

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-4 px-4 py-12 text-center text-muted sm:px-7">
      <div>{children}</div>
      {action}
    </div>
  );
}

/** A section that isn't built yet: says what it will be. */
export function ComingSoon({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-3 border-b border-border px-6 py-16 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-hover text-muted">{icon}</span>
      <p className="text-[17px] font-semibold">{title}</p>
      <div className="max-w-[460px] text-[14px] text-muted">{children}</div>
      <span className="rounded-md border border-border-strong px-2.5 py-1 text-[12px] font-semibold text-muted">Coming soon</span>
    </div>
  );
}

/** A link styled as a pill button. */
export function PillLink({ href, children, external, primary, size = "md" }: { href: string; children: ReactNode; external?: boolean; primary?: boolean; size?: "sm" | "md" }) {
  const className = buttonClass(primary ? "primary" : "secondary", size);
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

// Older names some pages still use while they move over.
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("grid gap-8 px-4 py-6 sm:px-7", className)}>{children}</div>;
}

export function RowList({ children, className, ...props }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("divide-y divide-border border-b border-border", className)} {...props}>
      {children}
    </div>
  );
}

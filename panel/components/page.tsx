// Page building blocks in the AgentOS look: each section is an outlined card
// (#1e1e1e with a #2a2a2a line in dark), 14px inside, rows split by fainter
// lines. Corners are 2px everywhere (globals.css). The layout spaces cards apart.
import { ChevronLeftIcon } from "lucide-react";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./icon";
import { buttonClass, cx } from "./ui";

/**
 * The top of every page: optional back button, a title ("piqo / Deployments",
 * the first part dimmed), quiet text under it, and actions on the right.
 */
export function PageHeader({ title, crumb, back, meta, subtitle, actions }: { title: ReactNode; crumb?: ReactNode; back?: string; meta?: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  const side = meta ?? subtitle;
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2.5">
        {back && (
          <Link href={back} aria-label="Back" className="mt-1 grid size-[26px] shrink-0 place-items-center border border-border text-foreground transition-colors duration-150 hover:bg-btn-hover">
            <Icon icon={ChevronLeftIcon} size={14} />
          </Link>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-[24px] font-bold leading-[1.3]">
            {crumb ? (
              <>
                <span className="text-dim">{title}</span>
                <span className="mx-1.5 text-dim">/</span>
                {crumb}
              </>
            ) : (
              title
            )}
          </h1>
          {side && <div className="mt-0.5 truncate text-muted">{side}</div>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

const TONE = { gold: "text-gold", ok: "text-teal", err: "text-rose", lav: "text-lavender" } as const;
const NOTICE_BG = { gold: "bg-warn-band", ok: "border border-border bg-card", err: "bg-err-band", lav: "border border-border bg-card" } as const;

/** One status line under the header: a colored lead word, then plain text. */
export function Notice({ lead, tone = "gold", children }: { lead: ReactNode; tone?: keyof typeof TONE; children: ReactNode }) {
  return (
    <div className={cx("px-3.5 py-2.5", NOTICE_BG[tone])} data-testid="notice">
      <b className={cx("mr-1.5 font-bold", TONE[tone])}>{lead}</b>
      {children}
    </div>
  );
}

/** A card with a title; lists inside run edge to edge. */
export function Section({ title, description, aside, children, className }: { title?: ReactNode; description?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx(CARD, className)}>
      {(title || aside) && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 px-3.5 pb-2.5 pt-3.5">
          <div className="grid gap-0.5">
            {title && <h2 className="flex items-center gap-2 text-[14px] font-bold">{title}</h2>}
            {description && <p className="text-[12px] text-muted">{description}</p>}
          </div>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/** The look of a card: #1e1e1e with a #2a2a2a line in dark, white with #eaeaea in light. */
export const CARD = "min-w-0 overflow-hidden border border-border bg-card";

/** Padding for non-list content inside a Section. */
export function SectionBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("px-3.5 pb-3.5", className)}>{children}</div>;
}

/** Settings layout: what it is on the left, the controls on the right. Rows next to each other on the page join into one card (globals.css). */
export function SettingsRow({ title, description, children, id }: { title: ReactNode; description?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <div id={id} data-srow="" className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-3 border-t border-border px-3.5 py-4 first:border-t-0 xl:grid-cols-[280px_minmax(0,1fr)]">
      <div>
        <h3 className="font-bold">{title}</h3>
        {description && <p className="mt-1 max-w-[280px] text-[12px] text-muted max-xl:max-w-none">{description}</p>}
      </div>
      <div className="grid max-w-[680px] grid-cols-[minmax(0,1fr)] content-start gap-3">{children}</div>
    </div>
  );
}

/** Label/value lines. inset: inside a SettingsRow (no side padding). flush: no line above (something else draws it). */
export function KeyValues({ items, inset, flush }: { items: [ReactNode, ReactNode][]; inset?: boolean; flush?: boolean }) {
  return (
    <div
      className={cx(
        "grid content-start",
        inset ? "grid-cols-[130px_minmax(0,1fr)] border-b border-border-soft" : "grid-cols-[110px_minmax(0,1fr)] sm:grid-cols-[150px_minmax(0,1fr)]",
        !inset && !flush && "border-t border-border",
      )}
    >
      {items.map(([k, v], i) => {
        const last = i === items.length - 1;
        const cell = cx("min-w-0", !last && "border-b border-border-soft", inset ? "py-2" : "px-3.5 py-2");
        return [
          <div key={`k${i}`} className={cx(cell, "text-muted")}>
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

/** Numbers separated by lines: inside a Section (inset), or a card of their own. */
export function Stats({ items, inset }: { items: Stat[]; inset?: boolean }) {
  return (
    <div className={cx("grid grid-cols-2", inset ? "border-y border-border" : CARD, items.length >= 5 ? "lg:grid-cols-5" : items.length === 3 ? "lg:grid-cols-3" : items.length === 2 ? "lg:grid-cols-2" : "lg:grid-cols-4")}>
      {items.map((s, i) => (
        <div key={i} className="grid min-w-0 gap-0.5 border-b border-border px-3.5 py-3 max-lg:odd:border-r lg:border-b-0 lg:border-r lg:last:border-r-0">
          <span className="text-[12px] text-muted">{s.label}</span>
          <span className="truncate whitespace-nowrap text-[22px] font-bold tabular-nums">
            {s.value}
            {s.small && <small className="ml-1 text-[12px] font-normal text-muted">{s.small}</small>}
          </span>
          {s.detail && <span className="truncate text-[12px] text-muted">{s.detail}</span>}
        </div>
      ))}
    </div>
  );
}

/** Filters as a segmented control (they live in the URL). */
export function Tabs({ items, className }: { items: { href: string; label: ReactNode; count?: number; active: boolean }[]; className?: string }) {
  return <Segmented items={items} className={className} />;
}

/** Links shown as one control on the field color: the chosen one a lighter tab. */
export function Segmented({ items, className }: { items: { href: string; label: ReactNode; count?: number; active: boolean; title?: string }[]; className?: string }) {
  return (
    <nav className={cx("inline-flex max-w-full gap-0.5 self-start justify-self-start overflow-x-auto border border-border bg-field p-[3px]", className)} aria-label="Filter">
      {items.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          scroll={false}
          title={t.title}
          aria-current={t.active ? "page" : undefined}
          className={cx("flex items-center whitespace-nowrap px-[13px] py-[5px] transition-colors duration-150", t.active ? "bg-raised text-foreground shadow-raise" : "text-muted hover:text-foreground")}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 text-[12px] tabular-nums text-dim">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** Column labels for a list. Columns are a grid-template-columns value. */
export function TableHead({ columns, children }: { columns: string; children: ReactNode }) {
  return (
    <div className="hidden h-9 items-center gap-x-5 border-b border-border px-3.5 text-[12px] text-muted md:grid" style={{ gridTemplateColumns: columns }}>
      {children}
    </div>
  );
}

/** One row of a list. On phones the columns wrap instead of squeezing. */
export function TableRow({ columns, href, highlight, children, className, ...rest }: { columns: string; href?: string; highlight?: boolean; children: ReactNode; className?: string } & Record<`data-${string}`, string | undefined>) {
  const cls = cx(
    "relative flex min-h-[44px] flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-soft px-3.5 py-2 transition-colors duration-150 last:border-b-0 md:grid md:gap-x-5",
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
        <div className="flex min-w-0 items-center gap-2 font-bold">{title}</div>
        {sub && <div className="flex min-w-0 items-center gap-1.5 truncate whitespace-nowrap text-[12px] text-muted">{sub}</div>}
      </div>
      {side ? <div className="flex items-center gap-2.5">{side}</div> : <span />}
      {children}
    </>
  );
  const cls = cx(
    "relative grid items-center gap-x-3 border-t border-border-soft py-2.5 transition-colors duration-150 [section>&:first-child]:border-t-0",
    lead ? "grid-cols-[auto_minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]",
    indent ? "px-3.5 md:pl-[60px]" : "px-3.5",
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

/** A square at the start of a row, its icon in the color of what it stands for. */
export function RowIcon({ children, tone = "dim" }: { children: ReactNode; tone?: "ok" | "warn" | "err" | "dim" | "lav" | "blue" | "coral" }) {
  const cls = {
    ok: "text-ok-dot",
    warn: "text-warn-dot",
    err: "text-err-dot",
    dim: "text-foreground",
    lav: "text-tile-lav",
    blue: "text-tile-blue",
    coral: "text-tile-coral",
  }[tone];
  return <span className={cx("grid size-8 shrink-0 place-items-center bg-well", cls)}>{children}</span>;
}

/** The color of a square icon for engines and integrations. */
export type TileTone = "dim" | "lav" | "blue" | "coral" | "teal" | "gold" | "rose";

/** A square with its icon in a color of its own (the text color for "dim"): 36px, or 32px in rows (size "sm"). */
export function TileIcon({ children, tone = "dim", size = "md" }: { children: ReactNode; tone?: TileTone; size?: "sm" | "md" }) {
  const cls = {
    dim: "text-foreground",
    lav: "text-tile-lav",
    blue: "text-tile-blue",
    coral: "text-tile-coral",
    teal: "text-tile-green",
    gold: "text-tile-gold",
    rose: "text-tile-red",
  }[tone];
  return <span className={cx("grid shrink-0 place-items-center bg-well", size === "sm" ? "size-8" : "size-9", cls)}>{children}</span>;
}

/** Separator dot inside detail lines. */
export const Dot = () => <span className="text-dim">·</span>;

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-3 px-3.5 py-10 text-center text-muted">
      <div>{children}</div>
      {action}
    </div>
  );
}

/** A section that isn't built yet: says what it will be. */
export function ComingSoon({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className={cx(CARD, "grid justify-items-center gap-2.5 px-6 py-14 text-center")}>
      <span className="grid size-10 place-items-center bg-well text-foreground">{icon}</span>
      <p className="text-[17px] font-bold">{title}</p>
      <div className="max-w-[460px] text-muted">{children}</div>
      <span className="bg-accent-soft px-[9px] py-px text-[11px] text-blue">Coming soon</span>
    </div>
  );
}

/** A link styled as a button. */
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
  return <div className={cx("grid gap-6", className)}>{children}</div>;
}

export function RowList({ children, className, ...props }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("divide-y divide-border-soft", CARD, className)} {...props}>
      {children}
    </div>
  );
}

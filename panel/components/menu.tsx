"use client";

import { EllipsisIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icon";
import { cx } from "./ui";

/** A row in a MoreMenu. */
export const MENU_ITEM = "flex w-full items-center gap-2 px-[9px] py-1.5 text-left transition-colors hover:bg-selected";

/**
 * A … button and its menu. The menu is drawn over the page (a portal), so the
 * edge of the list card it sits in can't cut it off; it opens upward when
 * there's no room below. Escape, a click elsewhere, scrolling or resizing
 * close it. `children` gets a function that closes it.
 */
export function MoreMenu({ iconSize = 15, ...props }: { label: string; children: (close: () => void) => ReactNode; buttonClassName?: string; width?: number; iconSize?: number }) {
  return <Dropdown {...props} trigger={<Icon icon={EllipsisIcon} size={iconSize} />} />;
}

/**
 * A button that opens a menu, as MoreMenu: the button shows `trigger`, and
 * the menu lines up with its right edge, or with its left edge and at least
 * its width (`align="left"`, as a picker).
 */
export function Dropdown({
  label,
  trigger,
  children,
  buttonClassName,
  width = 190,
  align = "right",
}: {
  label: string;
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  buttonClassName?: string;
  width?: number;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number; left: number; width: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Below the button, or above it when the menu wouldn't fit: measured before the browser paints.
  useLayoutEffect(() => {
    if (!open) return setPos(null);
    const r = button.current!.getBoundingClientRect();
    const edges = { right: window.innerWidth - r.right, left: r.left, width: r.width };
    const height = menu.current?.offsetHeight;
    if (height === undefined) return setPos({ top: r.bottom + 4, ...edges });
    setPos({ top: r.bottom + 4 + height <= window.innerHeight - 8 ? r.bottom + 4 : Math.max(8, r.top - 4 - height), ...edges });
  }, [open, pos === null]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !menu.current?.contains(t)) close();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button ref={button} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} className={buttonClassName}>
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            className={cx("fixed z-50 grid gap-px border border-border bg-card p-1 shadow-pop", !pos && "invisible")}
            style={align === "left" ? { top: pos?.top ?? 0, left: pos?.left ?? 0, minWidth: Math.max(width, pos?.width ?? 0) } : { top: pos?.top ?? 0, right: pos?.right ?? 0, minWidth: width }}
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </>
  );
}

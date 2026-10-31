"use client";

import { XIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Icon } from "./icon";

/** A centered dialog over a dimmed page. Escape and the backdrop close it. */
export function Modal({ open, onClose, icon, title, description, children, footer, label }: { open: boolean; onClose: () => void; icon?: ReactNode; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; label?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={label ?? (typeof title === "string" ? title : undefined)}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim" onClick={onClose} />
      <div className="absolute left-1/2 top-1/2 max-h-[88vh] w-[min(660px,92vw)] -translate-x-1/2 -translate-y-1/2 overflow-auto border border-border bg-panel shadow-pop">
        <div className="flex items-center gap-3 px-[18px] pb-1 pt-[18px]">
          {icon}
          <div className="grid min-w-0">
            <h3 className="text-[17px] font-bold">{title}</h3>
            {description && <span className="text-[12px] text-muted">{description}</span>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto grid size-[26px] place-items-center border border-border text-foreground transition-colors hover:bg-btn-hover">
            <Icon icon={XIcon} size={13} />
          </button>
        </div>
        {children}
        {footer && <div className="flex justify-end gap-2 border-t border-border px-[18px] py-3.5">{footer}</div>}
      </div>
    </div>
  );
}

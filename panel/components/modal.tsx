"use client";

import { Cancel01Icon } from "@hugeicons/core-free-icons";
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
      <button type="button" aria-label="Close" className="absolute inset-0 bg-scrim backdrop-blur-[3px]" onClick={onClose} />
      <div className="absolute left-1/2 top-1/2 max-h-[calc(100dvh-48px)] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-[20px] bg-card shadow-pop">
        <div className="flex items-center gap-3 border-b border-border py-[18px] pl-6 pr-4">
          {icon}
          <div className="grid min-w-0">
            <h3 className="text-[18px] font-semibold tracking-[-0.012em]">{title}</h3>
            {description && <span className="text-[13.5px] text-muted">{description}</span>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-foreground">
            <Icon icon={Cancel01Icon} size={18} />
          </button>
        </div>
        {children}
        {footer && <div className="flex justify-end gap-2 border-t border-border px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}

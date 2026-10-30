"use client";

import { Search01Icon } from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icon";
import { NO_AUTOFILL, cx } from "../ui";

export interface PaletteItem {
  label: string;
  href: string;
  hint: string;
}

export const openPalette = () => window.dispatchEvent(new Event("layer:palette"));

/** ⌘K: jump to any page or project. */
export function CommandPalette({ items }: { items: PaletteItem[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    const show = () => {
      setOpen(true);
      setQuery("");
      setIndex(0);
      setTimeout(() => input.current?.focus(), 0);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => {
          if (!o) setTimeout(show, 0);
          return !o;
        });
      }
    };
    window.addEventListener("layer:palette", show);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("layer:palette", show);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => !q || i.label.toLowerCase().includes(q) || i.hint.toLowerCase().includes(q)).slice(0, 12);
  }, [items, query]);

  if (!open) return null;
  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Search">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
      <div className="absolute left-1/2 top-[12vh] w-[min(600px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-2xl border border-border-strong bg-background shadow-[0_24px_60px_rgba(0,0,0,0.45)]">
        <div className="flex items-center gap-3 border-b border-border px-5">
          <Icon icon={Search01Icon} size={18} className="text-dim" />
          <input
            {...NO_AUTOFILL}
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, matches.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              }
              if (e.key === "Enter" && matches[index]) go(matches[index].href);
            }}
            placeholder="Search projects and pages…"
            className="h-[54px] flex-1 bg-transparent text-base outline-none placeholder:text-dim"
          />
        </div>
        <div className="max-h-[360px] overflow-auto py-1.5">
          {matches.length === 0 && <p className="px-5 py-3 text-muted">No results</p>}
          {matches.map((m, i) => (
            <button
              key={m.href}
              type="button"
              onMouseEnter={() => setIndex(i)}
              onClick={() => go(m.href)}
              className={cx("flex h-[42px] w-full items-center gap-3 px-5 text-left", i === index ? "bg-selected text-foreground" : "text-muted")}
            >
              {m.label}
              <small className="ml-auto text-[12px] text-dim">{m.hint}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

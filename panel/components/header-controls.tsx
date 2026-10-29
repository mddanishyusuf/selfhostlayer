"use client";

import { Search01Icon } from "@hugeicons/core-free-icons";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icon";
import { openServerModal } from "./shell/server-modal";

/** The "● server · CPU · RAM" pill that opens the server modal. */
export function ServerButton({ children }: { children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={openServerModal}
      title="Server status"
      className="inline-flex h-[34px] items-center gap-2 whitespace-nowrap rounded-full border border-border-strong px-3.5 text-[13px] text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground"
    >
      {children}
    </button>
  );
}

/** A search box that keeps its text in the URL (?q=), so the server filters. */
export function FilterBox({ placeholder, param = "q" }: { placeholder: string; param?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [value, setValue] = useState(params.get(param) ?? "");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <label className="hidden h-[34px] w-[220px] items-center gap-2 rounded-full border border-border-strong px-3 text-dim lg:flex">
      <Icon icon={Search01Icon} size={15} />
      <input
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            const q = new URLSearchParams(params);
            if (next.trim()) q.set(param, next.trim());
            else q.delete(param);
            router.replace(`${pathname}${q.size ? `?${q}` : ""}`, { scroll: false });
          }, 200);
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-dim"
      />
    </label>
  );
}

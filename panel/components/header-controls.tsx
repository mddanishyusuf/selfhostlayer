"use client";

import { Search01Icon } from "@hugeicons/core-free-icons";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icon";
import { NO_AUTOFILL, cx } from "./ui";

/** A search box that keeps its text in the URL (?q=), so the server filters. */
export function FilterBox({ placeholder, param = "q", className }: { placeholder: string; param?: string; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [value, setValue] = useState(params.get(param) ?? "");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <label
      className={cx(
        "flex h-[34px] min-w-0 items-center gap-2 rounded-lg border border-border bg-field px-3 text-dim transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)]",
        className,
      )}
    >
      <Icon icon={Search01Icon} size={15} />
      <input
        {...NO_AUTOFILL}
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

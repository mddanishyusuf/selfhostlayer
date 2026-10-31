"use client";

import { SearchIcon } from "lucide-react";
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
        "flex h-[35px] min-w-0 items-center gap-2 border border-border bg-field px-2.5 text-placeholder transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:shadow-focus",
        className,
      )}
    >
      <Icon icon={SearchIcon} size={15} />
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

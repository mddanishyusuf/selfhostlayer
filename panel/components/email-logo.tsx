"use client";

import { useState } from "react";
import { COLORS } from "@/lib/avatar";
import { cx } from "./ui";

/**
 * A brand's logo: its domain's icon from Google's favicon service (the browser
 * asks Google for it, so Google sees the domain and nothing else), or its
 * initial on a color of its own when there's no domain or no icon.
 */
export function BrandLogo({ name, domain, size = 28, className }: { name: string; domain?: string | null; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size };
  if (domain && !failed) {
    return (
      <span className={cx("grid shrink-0 place-items-center overflow-hidden bg-white", className)} style={box}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a remote icon, sized here */}
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
          alt=""
          width={Math.round(size * 0.72)}
          height={Math.round(size * 0.72)}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          // Google answers a default globe with a 16px image; a real icon at sz=64 is bigger.
          onLoad={(e) => e.currentTarget.naturalWidth <= 16 && setFailed(true)}
        />
      </span>
    );
  }
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className={cx("grid shrink-0 place-items-center font-black uppercase text-white", className)} style={{ ...box, background: COLORS[hash % COLORS.length], fontSize: Math.round(size * 0.46) }} aria-hidden>
      {name.slice(0, 1)}
    </span>
  );
}

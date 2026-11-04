"use client";

import { useEffect, useState } from "react";
import { COLORS } from "@/lib/avatar";
import { cx } from "./ui";

/** Icons already fetched in this tab, by domain: null when there's none. */
const found = new Map<string, string | null>();

/**
 * A brand's logo: its initial on a color of its own, replaced by its domain's
 * icon from Google's favicon service once that has loaded (the browser asks
 * Google, so Google sees the domain and nothing else). The icon is fetched
 * after the page is up, never by the page itself: a slow or blocked Google
 * neither holds up the page nor leaves an empty box. Google answers a domain
 * without an icon with a 16px globe, which counts as none.
 */
export function BrandLogo({ name, domain, size = 28, className }: { name: string; domain?: string | null; size?: number; className?: string }) {
  // The server and the first render show the initial: the icon comes after hydration.
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    if (!domain) return setIcon(null);
    if (found.has(domain)) return setIcon(found.get(domain)!);
    const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    let done = false;
    const settle = (ok: boolean) => {
      if (done) return;
      done = true;
      found.set(domain, ok ? url : null);
      setIcon(ok ? url : null);
    };
    img.onload = () => settle(img.naturalWidth > 16);
    img.onerror = () => settle(false);
    const timer = setTimeout(() => settle(false), 4000);
    img.src = url;
    return () => {
      done = true;
      clearTimeout(timer);
    };
  }, [domain]);
  const box = { width: size, height: size };
  if (icon) {
    return (
      <span className={cx("grid shrink-0 place-items-center overflow-hidden bg-white", className)} style={box}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a remote icon, already loaded */}
        <img src={icon} alt="" width={Math.round(size * 0.72)} height={Math.round(size * 0.72)} referrerPolicy="no-referrer" />
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

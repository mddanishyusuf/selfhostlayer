"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** A project's mark as its site's favicon, on a light tile; the letter mark if the icon won't load. */
export function SiteIcon({ src, size, fallback }: { src: string; size: "sm" | "md"; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  // An image that failed before the page hydrated never fires onError: check once mounted.
  useEffect(() => {
    if (img.current?.complete && img.current.naturalWidth === 0) setFailed(true);
  }, []);
  if (failed) return <>{fallback}</>;
  return (
    <span className={`grid shrink-0 place-items-center bg-white ring-1 ring-inset ring-black/10 ${size === "sm" ? "size-[30px] rounded-[9px]" : "size-10 rounded-[11px]"}`} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element -- a tiny same-origin icon; next/image would add nothing */}
      <img ref={img} src={src} alt="" onError={() => setFailed(true)} className={size === "sm" ? "size-[18px]" : "size-6"} />
    </span>
  );
}

"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { money } from "@/lib/money";

const W = 600;
const H = 140;

/** A round top for the y-axis: 1, 2, 2.5 or 5 times a power of ten. */
function niceMax(value: number): number {
  const target = Math.max(4, value * 1.15);
  const pow = 10 ** Math.floor(Math.log10(target));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * pow >= target) return step * pow;
  return 10 * pow;
}

type Bucket = "minute" | "hour" | "day";

const label = (at: number, bucket: Bucket) =>
  new Date(at).toLocaleString(
    "en-GB",
    bucket === "minute" ? { hour: "2-digit", minute: "2-digit", timeZone: "UTC" } : bucket === "hour" ? { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" } : { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" },
  );

export interface Bar {
  at: number;
  value: number;
  /** A second number for the tooltip and the table, like "12 visitors". */
  detail?: string;
}

const count = (n: number, noun: [string, string], currency?: string) => (currency ? money(n, currency) : `${n.toLocaleString("en")} ${n === 1 ? noun[0] : noun[1]}`);

/**
 * One number per minute, hour or day as bars (clicks, visitors, revenue in a
 * currency's cents), with a 2px gap between them and hairline gridlines.
 * Hovering a bar, or the arrow keys, shows its number and detail; the numbers
 * are also a table.
 */
export function BarChart({ points: series, bucket, noun, currency, testId }: { points: Bar[]; bucket: Bucket; noun: [string, string]; currency?: string; testId?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // Money: a round top in whole units of the currency.
  const unit = currency ? 100 : 1;
  const max = niceMax(Math.max(0, ...series.map((p) => p.value)) / unit) * unit;
  const axis = (n: number) => (currency ? money(n, currency, true) : String(n));
  const slot = W / Math.max(1, series.length);
  const total = series.reduce((a, p) => a + p.value, 0);
  const point = hover !== null ? series[hover] : undefined;
  const pick = (e: PointerEvent) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || !series.length) return;
    setHover(Math.max(0, Math.min(series.length - 1, Math.floor(((e.clientX - rect.left) / rect.width) * series.length))));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      setHover((h) => Math.max(0, Math.min(series.length - 1, (h ?? series.length - 1) + (e.key === "ArrowLeft" ? -1 : 1))));
    } else if (e.key === "Escape") setHover(null);
  };
  const pct = (i: number) => ((i + 0.5) / series.length) * 100;
  return (
    <div className="grid gap-2" data-testid={testId}>
      <div
        ref={box}
        role="img"
        aria-label={`${count(total, noun, currency)} in the last ${series.length} ${bucket}s, at most ${count(Math.max(0, ...series.map((p) => p.value)), noun, currency)} in one ${bucket}.`}
        tabIndex={0}
        onPointerMove={pick}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setHover((h) => h ?? series.length - 1)}
        onBlur={() => setHover(null)}
        onKeyDown={onKey}
        className="relative h-[160px] cursor-crosshair outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden>
          {[0, 0.5, 1].map((f) => (
            <line key={f} x1={0} x2={W} y1={H - f * H} y2={H - f * H} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {series.map((p, i) => {
            const h = (p.value / max) * H;
            return p.value > 0 ? <rect key={p.at} x={i * slot + 1} y={H - h} width={Math.max(1, slot - 2)} height={h} fill="var(--chart)" opacity={hover === null || hover === i ? 1 : 0.45} /> : null;
          })}
        </svg>
        <span className="pointer-events-none absolute left-0 top-0 -translate-y-1/2 bg-card pr-1.5 text-[11px] tabular-nums text-dim">{axis(max)}</span>
        <span className="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 bg-card pr-1.5 text-[11px] tabular-nums text-dim">{axis(max / 2)}</span>
        {total === 0 && <span className="absolute inset-0 grid place-items-center text-[12px] text-dim">No {noun[1]} in this time.</span>}
        {point && (
          <span
            className="pointer-events-none absolute top-1 z-10 grid whitespace-nowrap border border-border bg-card px-2.5 py-1.5 shadow-pop"
            style={pct(hover!) > 60 ? { right: `${100 - pct(hover!) + 2}%` } : { left: `${pct(hover!) + 2}%` }}
          >
            <b className="text-[13px] font-semibold tabular-nums">
              {count(point.value, noun, currency)} {point.detail && <span className="font-normal text-muted">· {point.detail}</span>}
            </b>
            <span className="text-[11.5px] text-muted">{label(point.at, bucket)} UTC</span>
          </span>
        )}
      </div>
      <div className="flex justify-between text-[11.5px] text-dim">
        <span>{series[0] ? label(series[0].at, bucket) : ""}</span>
        <span>{bucket === "minute" ? "now" : bucket === "hour" ? "this hour" : "today"}</span>
      </div>
      <details className="group border-t border-border">
        <summary className="cursor-pointer list-none py-2.5 text-[12px] text-muted hover:text-foreground">
          <span className="group-open:hidden">Show</span>
          <span className="hidden group-open:inline">Hide</span> the numbers as a table
        </summary>
        <table className="w-full text-[13px] tabular-nums">
          <thead>
            <tr className="border-y border-border text-left text-dim">
              <th className="py-1.5 font-normal">{bucket === "minute" ? "Minute (UTC)" : bucket === "hour" ? "Hour (UTC)" : "Day (UTC)"}</th>
              <th className="py-1.5 text-right font-normal">{noun[1][0]!.toUpperCase() + noun[1].slice(1)}</th>
              <th className="py-1.5 text-right font-normal" />
            </tr>
          </thead>
          <tbody>
            {[...series].reverse().map((p) => (
              <tr key={p.at} className="border-b border-border-soft last:border-b-0">
                <td className="py-1">{label(p.at, bucket)}</td>
                <td className="py-1 text-right">{currency ? money(p.value, currency) : p.value}</td>
                <td className="py-1 text-right text-muted">{p.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

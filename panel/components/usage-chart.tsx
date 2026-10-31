"use client";

import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export interface ChartPoint {
  at: number;
  value: number | null;
}

const W = 600;
const H = 140;

/** A round top for the y-axis: 1, 2, 2.5 or 5 times a power of ten. */
function niceMax(value: number, floor: number): number {
  const target = Math.max(floor, value * 1.15);
  const pow = 10 ** Math.floor(Math.log10(target));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * pow >= target) return step * pow;
  return 10 * pow;
}

const fmt = (v: number, unit: "%" | "MB") => (unit === "%" ? `${v < 10 ? v.toFixed(1) : Math.round(v)}%` : v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`);
const when = (at: number, range: number) =>
  new Date(at).toLocaleString(undefined, range > 2 * 86_400_000 ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });

/**
 * One series over time: a 2px line over a 10% wash, hairline gridlines, and a
 * crosshair that snaps to the nearest point (pointer or arrow keys). Points
 * further apart than `gapMs`, or null, break the line: no data, no line.
 */
export function UsageChart({
  title,
  unit,
  points,
  from,
  to,
  gapMs,
  floor = unit === "%" ? 5 : 64,
}: {
  title: string;
  unit: "%" | "MB";
  points: ChartPoint[];
  from: number;
  to: number;
  gapMs: number;
  floor?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const values = useMemo(() => points.filter((p): p is { at: number; value: number } => p.value !== null), [points]);
  const max = niceMax(Math.max(0, ...values.map((p) => p.value)), floor);
  const x = (at: number) => ((at - from) / (to - from)) * W;
  const y = (v: number) => H - (v / max) * H;

  const { line, area } = useMemo(() => {
    const segments: { at: number; value: number }[][] = [];
    let current: { at: number; value: number }[] = [];
    for (const p of points) {
      const last = current.at(-1);
      if (p.value === null || (last && p.at - last.at > gapMs)) {
        if (current.length) segments.push(current);
        current = p.value === null ? [] : [{ at: p.at, value: p.value }];
      } else current.push({ at: p.at, value: p.value });
    }
    if (current.length) segments.push(current);
    const px = (at: number) => (((at - from) / (to - from)) * W).toFixed(1);
    const py = (v: number) => (H - (v / max) * H).toFixed(1);
    const toPath = (s: { at: number; value: number }[]) => s.map((p, i) => `${i ? "L" : "M"}${px(p.at)},${py(p.value)}`).join("");
    return {
      line: segments.map(toPath).join(""),
      area: segments.map((s) => `${toPath(s)}L${px(s.at(-1)!.at)},${H}L${px(s[0]!.at)},${H}Z`).join(""),
    };
  }, [points, from, to, max, gapMs]);

  const nearest = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || !values.length) return null;
    const at = from + ((clientX - rect.left) / rect.width) * (to - from);
    let best = 0;
    for (let i = 1; i < values.length; i++) if (Math.abs(values[i]!.at - at) < Math.abs(values[best]!.at - at)) best = i;
    return best;
  };
  const onKey = (e: KeyboardEvent) => {
    if (!values.length) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      setHover((h) => Math.max(0, Math.min(values.length - 1, (h ?? values.length - 1) + (e.key === "ArrowLeft" ? -1 : 1))));
    } else if (e.key === "Escape") setHover(null);
  };
  const point = hover !== null ? values[hover] : undefined;
  const last = values.at(-1);
  const peak = values.reduce<{ at: number; value: number } | undefined>((a, p) => (!a || p.value > a.value ? p : a), undefined);
  const summary = last ? `${title}: now ${fmt(last.value, unit)}, highest ${fmt(peak!.value, unit)}.` : `${title}: no data yet.`;
  const left = (at: number) => `${(x(at) / W) * 100}%`;

  return (
    <div className="grid gap-2" data-testid="usage-chart">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] text-muted">{title}</span>
        <span className="text-[17px] font-semibold tabular-nums">{last ? fmt(last.value, unit) : "—"}</span>
      </div>
      <div
        ref={box}
        role="img"
        aria-label={summary}
        tabIndex={values.length ? 0 : -1}
        onPointerMove={(e: PointerEvent) => setHover(nearest(e.clientX))}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setHover((h) => h ?? (values.length ? values.length - 1 : null))}
        onBlur={() => setHover(null)}
        onKeyDown={onKey}
        className="relative h-[140px] cursor-crosshair rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
          {[0, 0.5, 1].map((f) => (
            <line key={f} x1={0} x2={W} y1={H - f * H} y2={H - f * H} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          <path d={area} fill="var(--chart)" fillOpacity={0.1} />
          <path d={line} fill="none" stroke="var(--chart)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="pointer-events-none absolute left-0 top-0 -translate-y-1/2 bg-background pr-1.5 text-[11px] tabular-nums text-dim">{fmt(max, unit)}</span>
        <span className="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 bg-background pr-1.5 text-[11px] tabular-nums text-dim">{fmt(max / 2, unit)}</span>
        {!values.length && <span className="absolute inset-0 grid place-items-center text-center text-[12px] text-dim">No data yet: the first samples arrive within a few minutes.</span>}
        {point && (
          <>
            <span className="pointer-events-none absolute inset-y-0 w-px bg-border-strong" style={{ left: left(point.at) }} />
            <span
              className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-chart"
              style={{ left: left(point.at), top: `${(y(point.value) / H) * 100}%` }}
            />
            <span
              className="pointer-events-none absolute top-1 z-10 grid whitespace-nowrap rounded-[10px] border border-border bg-card px-2.5 py-1.5 shadow-pop"
              style={x(point.at) > W * 0.6 ? { right: `${100 - (x(point.at) / W) * 100 + 2}%` } : { left: `${(x(point.at) / W) * 100 + 2}%` }}
            >
              <b className="text-[13px] font-semibold tabular-nums">{fmt(point.value, unit)}</b>
              <span className="text-[11.5px] text-muted">{when(point.at, to - from)}</span>
            </span>
          </>
        )}
      </div>
      <div className="flex justify-between text-[11.5px] text-dim">
        <span>{to - from > 2 * 86_400_000 ? "7 days ago" : "24 hours ago"}</span>
        <span>now</span>
      </div>
    </div>
  );
}

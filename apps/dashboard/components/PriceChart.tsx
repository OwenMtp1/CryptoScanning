"use client";

import type { Candle } from "@radar/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtPct, fmtPrice } from "@/lib/format";

/** A horizontal price level drawn over the chart (entry, stop, target, liquidation…). */
export interface PriceLevel {
  y: number;
  label: string;
  color: string;
  dashed?: boolean;
  /** Stretch the vertical scale so the level is visible (otherwise an edge marker is shown). */
  fit?: boolean;
}
export interface PriceBand {
  y1: number;
  y2: number;
  color: string;
  label: string;
}

const SURFACE = "#0b1220";
const GRID = "#1e293b";
const AXIS_TEXT = "#94a3b8";
const LINE = "#38bdf8";
const PAD_WIDE = { top: 16, right: 12, bottom: 26, left: 64 };
const PAD_NARROW = { top: 14, right: 6, bottom: 24, left: 48 };

function niceTicks(lo: number, hi: number, n = 5): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
  return out;
}

const timeLabel = (t: number, spanMs: number) => {
  const d = new Date(t);
  if (spanMs <= 36 * 3_600_000) return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (spanMs <= 120 * 86_400_000) return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
  return d.toLocaleDateString("fr-FR", { month: "short", year: "2-digit" });
};

export function PriceChart({ candles, levels = [], bands = [], height: tall = 380, title }: { candles: Candle[]; levels?: PriceLevel[]; bands?: PriceBand[]; height?: number; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  const narrow = width < 560;
  const PAD = narrow ? PAD_NARROW : PAD_WIDE;
  const height = narrow ? Math.min(tall, 290) : tall;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const on = () => setWidth(Math.max(280, el.clientWidth));
    on();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(on) : null;
    ro?.observe(el);
    window.addEventListener("resize", on);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", on);
    };
  }, []);

  const g = useMemo(() => {
    if (candles.length < 2) return null;
    let lo = Math.min(...candles.map((c) => c.l));
    let hi = Math.max(...candles.map((c) => c.h));
    for (const l of levels) if (l.fit) (lo = Math.min(lo, l.y)), (hi = Math.max(hi, l.y));
    for (const b of bands) (lo = Math.min(lo, b.y1, b.y2)), (hi = Math.max(hi, b.y1, b.y2));
    const pad = (hi - lo) * 0.05 || hi * 0.01;
    lo -= pad;
    hi += pad;
    const t0 = candles[0]!.t;
    const t1 = candles[candles.length - 1]!.t;
    const iw = width - PAD.left - PAD.right;
    const ih = height - PAD.top - PAD.bottom;
    const x = (t: number) => PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * iw;
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * ih;
    const line = candles.map((c, i) => `${i ? "L" : "M"}${x(c.t).toFixed(1)},${y(c.c).toFixed(1)}`).join("");
    const area = `${line}L${x(t1).toFixed(1)},${(PAD.top + ih).toFixed(1)}L${x(t0).toFixed(1)},${(PAD.top + ih).toFixed(1)}Z`;
    const yTicks = niceTicks(lo, hi, 5);
    const nx = Math.max(2, Math.min(7, Math.floor(iw / 110)));
    const xTicks = Array.from({ length: nx }, (_, i) => t0 + ((t1 - t0) * i) / (nx - 1));
    return { lo, hi, x, y, line, area, yTicks, xTicks, iw, ih, t0, t1 };
  }, [candles, levels, bands, width, height, PAD]);

  if (!g) return <div className="flex h-40 items-center justify-center text-sm text-slate-500">Pas assez de données pour tracer la courbe.</div>;

  const first = candles[0]!;
  const lastC = candles[candles.length - 1]!;
  const hv = hover !== null ? candles[hover] : null;
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    const t = g.t0 + (px / r.width) * (g.t1 - g.t0);
    let best = 0;
    let bd = Infinity;
    // Candles are evenly spaced: binary-search free nearest lookup is fine at these sizes.
    for (let i = 0; i < candles.length; i++) {
      const d = Math.abs(candles[i]!.t - t);
      if (d < bd) (bd = d), (best = i);
    }
    setHover(best);
  };

  // Levels outside the visible scale are shown as markers on the edge.
  const visible = levels.filter((l) => l.y >= g.lo && l.y <= g.hi);
  const above = levels.filter((l) => l.y > g.hi);
  const below = levels.filter((l) => l.y < g.lo);
  // Keep labels from colliding: sort by y and push apart by 14 px.
  const placed = visible
    .map((l) => ({ ...l, py: g.y(l.y) }))
    .sort((a, b) => a.py - b.py)
    .reduce<(PriceLevel & { py: number; ly: number })[]>((acc, l) => {
      const prev = acc[acc.length - 1];
      acc.push({ ...l, ly: prev && l.py - 4 - prev.ly < 14 ? prev.ly + 14 : l.py - 4 });
      return acc;
    }, []);

  return (
    <div ref={box} className="relative w-full select-none" role="img" aria-label={`${title} : de ${fmtPrice(first.c)} à ${fmtPrice(lastC.c)} (${fmtPct(((lastC.c - first.c) / first.c) * 100)})`}>
      <svg width={width} height={height} className="block">
        <rect x={0} y={0} width={width} height={height} fill={SURFACE} rx={6} />
        {g.yTicks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={width - PAD.right} y1={g.y(v)} y2={g.y(v)} stroke={GRID} strokeWidth={1} />
            <text x={PAD.left - 6} y={g.y(v) + 4} textAnchor="end" fontSize={narrow ? 10 : 11} fill={AXIS_TEXT} className="num">
              {fmtPrice(v)}
            </text>
          </g>
        ))}
        {g.xTicks.map((t, i) => (
          <text key={i} x={g.x(t)} y={height - 8} textAnchor={i === 0 ? "start" : i === g.xTicks.length - 1 ? "end" : "middle"} fontSize={11} fill={AXIS_TEXT}>
            {timeLabel(t, g.t1 - g.t0)}
          </text>
        ))}
        {bands.map((b, i) => (
          <g key={`b${i}`}>
            <rect x={PAD.left} width={g.iw} y={g.y(Math.max(b.y1, b.y2))} height={Math.max(2, Math.abs(g.y(b.y1) - g.y(b.y2)))} fill={b.color} opacity={0.14} />
          </g>
        ))}
        <path d={g.area} fill={LINE} opacity={0.1} />
        <path d={g.line} fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {placed.map((l, i) => (
          <g key={`l${i}`}>
            <line x1={PAD.left} x2={width - PAD.right} y1={l.py} y2={l.py} stroke={l.color} strokeWidth={1.5} strokeDasharray={l.dashed ? "6 4" : undefined} />
            <g transform={`translate(${width - PAD.right - 4},${l.ly})`}>
              <rect x={-(l.label.length * 6.2 + 26)} y={-11} width={l.label.length * 6.2 + 26} height={15} rx={3} fill={SURFACE} opacity={0.85} />
              <line x1={-(l.label.length * 6.2 + 22)} x2={-(l.label.length * 6.2 + 12)} y1={-4} y2={-4} stroke={l.color} strokeWidth={2} strokeDasharray={l.dashed ? "3 2" : undefined} />
              <text x={-4} y={0} textAnchor="end" fontSize={11} fill="#cbd5e1">
                {l.label}
              </text>
            </g>
          </g>
        ))}
        {above.map((l, i) => (
          <text key={`a${i}`} x={PAD.left + 6} y={PAD.top + 12 + i * 14} fontSize={11} fill="#cbd5e1">
            ↑ {l.label} (hors écran)
          </text>
        ))}
        {below.map((l, i) => (
          <text key={`d${i}`} x={PAD.left + 6} y={PAD.top + g.ih - 6 - i * 14} fontSize={11} fill="#cbd5e1">
            ↓ {l.label} (hors écran)
          </text>
        ))}
        <circle cx={g.x(lastC.t)} cy={g.y(lastC.c)} r={4} fill={LINE} stroke={SURFACE} strokeWidth={2} />
        {hv && (
          <g pointerEvents="none">
            <line x1={g.x(hv.t)} x2={g.x(hv.t)} y1={PAD.top} y2={PAD.top + g.ih} stroke="#64748b" strokeWidth={1} />
            <circle cx={g.x(hv.t)} cy={g.y(hv.c)} r={5} fill={LINE} stroke={SURFACE} strokeWidth={2} />
          </g>
        )}
        <rect x={PAD.left} y={PAD.top} width={g.iw} height={g.ih} fill="transparent" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} style={{ touchAction: "pan-y" }} />
      </svg>
      {hv && (
        <div
          className="pointer-events-none absolute z-10 rounded border border-slate-700 bg-slate-950/95 px-2.5 py-1.5 text-xs shadow-lg"
          style={{ left: g.x(hv.t) > width / 2 ? Math.max(0, g.x(hv.t) - 200) : Math.min(width - 190, g.x(hv.t) + 12), top: 8 }}
        >
          <div className="num text-sm font-semibold text-slate-100">{fmtPrice(hv.c)} $</div>
          <div className="text-slate-400">{new Date(hv.t).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</div>
          <div className="num text-slate-400">
            O {fmtPrice(hv.o)} · H {fmtPrice(hv.h)} · B {fmtPrice(hv.l)}
          </div>
          <div className="num text-slate-300">depuis le début : {fmtPct(((hv.c - first.c) / first.c) * 100)}</div>
        </div>
      )}
    </div>
  );
}

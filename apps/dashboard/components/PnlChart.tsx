"use client";

import type { EquityPoint } from "@radar/core";
import { useEffect, useRef, useState } from "react";
import { fmtDateTime, fmtMoney, fmtTime } from "@/lib/format";

const H = 220;
const PAD = { l: 64, r: 16, t: 14, b: 26 };
// Series color validated (dataviz validator) against the dashboard surface #0c1322.
const SERIES = "#3987e5";
const SURFACE = "#0c1322";

/**
 * Cumulative trading P&L over time (one series → no legend; the title names it).
 * Crosshair + tooltip on hover; values are also available in the trades table.
 */
export function PnlChart({ points, currency }: { points: EquityPoint[]; currency: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (points.length < 2) {
    return (
      <div ref={box} className="flex h-[220px] items-center justify-center rounded border border-slate-800 text-sm text-slate-500">
        Pas encore assez de points (un point par intervalle d&apos;échantillonnage).
      </div>
    );
  }

  const t0 = points[0]!.ts;
  const t1 = points[points.length - 1]!.ts;
  const vals = points.map((p) => p.tradingPnl);
  let lo = Math.min(0, ...vals);
  let hi = Math.max(0, ...vals);
  if (hi - lo < 0.02) {
    hi += 0.01;
    lo -= 0.01;
  }
  const span = hi - lo;
  lo -= span * 0.08;
  hi += span * 0.08;
  const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.tradingPnl).toFixed(1)}`).join("");
  const ticks = [hi - (hi - lo) * 0.08, 0, lo + (hi - lo) * 0.08].filter((v, i, a) => a.findIndex((u) => Math.abs(u - v) < (hi - lo) * 0.1) === i);
  const last = points[points.length - 1]!;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left + PAD.l;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(points[i]!.ts) - px) < Math.abs(x(points[best]!.ts) - px)) best = i;
    setHover(best);
  };
  const hp = hover === null ? null : points[hover]!;

  return (
    <div ref={box} className="relative">
      <svg width={w} height={H} role="img" aria-label={`P&L trading cumulé, dernier point ${fmtMoney(last.tradingPnl, currency, true)}`}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={w - PAD.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? "#475569" : "#1e293b"} strokeWidth={1} />
            <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill="#94a3b8">
              {fmtMoney(v, currency)}
            </text>
          </g>
        ))}
        <text x={PAD.l} y={H - 6} fontSize={11} fill="#94a3b8">
          {fmtTime(t0)}
        </text>
        <text x={w - PAD.r} y={H - 6} fontSize={11} fill="#94a3b8" textAnchor="end">
          {fmtTime(t1)}
        </text>
        <path d={d} fill="none" stroke={SERIES} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {/* End marker + direct label of the last value */}
        <circle cx={x(last.ts)} cy={y(last.tradingPnl)} r={4} fill={SERIES} stroke={SURFACE} strokeWidth={2} />
        {hp && (
          <g pointerEvents="none">
            <line x1={x(hp.ts)} x2={x(hp.ts)} y1={PAD.t} y2={H - PAD.b} stroke="#64748b" strokeWidth={1} />
            <circle cx={x(hp.ts)} cy={y(hp.tradingPnl)} r={4.5} fill={SERIES} stroke={SURFACE} strokeWidth={2} />
          </g>
        )}
        <rect
          x={PAD.l}
          y={PAD.t}
          width={w - PAD.l - PAD.r}
          height={H - PAD.t - PAD.b}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hp && (
        <div
          className="pointer-events-none absolute rounded border border-slate-700 bg-slate-950/95 px-2 py-1 text-xs shadow"
          style={{ left: Math.min(w - 170, Math.max(0, x(hp.ts) + 10)), top: 8 }}
        >
          <div className="num font-semibold text-slate-100">{fmtMoney(hp.tradingPnl, currency, true)}</div>
          <div className="flex items-center gap-1.5 text-slate-400">
            <span className="inline-block h-0.5 w-3" style={{ background: SERIES }} />
            P&amp;L trading · {fmtDateTime(hp.ts)}
          </div>
          <div className="num text-slate-500">valeur totale {fmtMoney(hp.total, currency)}</div>
        </div>
      )}
    </div>
  );
}

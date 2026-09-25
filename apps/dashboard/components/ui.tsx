import type { SignalType } from "@radar/core";
import type { ReactNode } from "react";

export function Card({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-slate-800 bg-slate-900/50 p-4 ${className}`}>
      {title && <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h2>}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone = "default" }: { label: string; value: ReactNode; hint?: string; tone?: "default" | "good" | "warn" | "bad" | "muted" }) {
  const color = { default: "text-slate-100", good: "text-emerald-400", warn: "text-amber-300", bad: "text-rose-400", muted: "text-slate-500" }[tone];
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`num text-xl font-semibold ${color}`}>{value}</div>
      {hint && <div className="text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}

export function ScoreBar({ score }: { score: number }) {
  const color = score >= 75 ? "bg-emerald-400" : score >= 60 ? "bg-lime-400" : score >= 40 ? "bg-amber-400" : "bg-slate-600";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-14 overflow-hidden rounded bg-slate-800">
        <div className={`h-full ${color}`} style={{ width: `${Math.max(2, score)}%` }} />
      </div>
      <span className="num w-7 text-right font-semibold">{score}</span>
    </div>
  );
}

const SIGNAL_STYLE: Record<SignalType, { label: string; cls: string; title: string }> = {
  PRICE_SURGE: { label: "SURGE", cls: "bg-emerald-500/15 text-emerald-300", title: "Hausse anormale du prix" },
  PRICE_DROP: { label: "DROP", cls: "bg-rose-500/15 text-rose-300", title: "Baisse anormale du prix" },
  VOLUME_SPIKE: { label: "VOL", cls: "bg-sky-500/15 text-sky-300", title: "Pic de volume vs baseline" },
  ACCELERATION: { label: "ACC", cls: "bg-violet-500/15 text-violet-300", title: "Accélération du mouvement" },
  LIQUIDITY_WARNING: { label: "LIQ!", cls: "bg-amber-500/20 text-amber-300", title: "Liquidité insuffisante" },
};

export function SignalChips({ types }: { types: SignalType[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {types.map((t) => (
        <span key={t} title={SIGNAL_STYLE[t].title} className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${SIGNAL_STYLE[t].cls}`}>
          {SIGNAL_STYLE[t].label}
        </span>
      ))}
    </div>
  );
}

export function LevelBadge({ level }: { level: "debug" | "info" | "warn" | "error" }) {
  const cls = { debug: "text-slate-500", info: "text-sky-300", warn: "text-amber-300", error: "text-rose-400" }[level];
  return <span className={`text-[11px] font-bold uppercase ${cls}`}>{level}</span>;
}

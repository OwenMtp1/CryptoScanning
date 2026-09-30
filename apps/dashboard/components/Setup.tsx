"use client";

import { positionSize, type TradeSetup } from "@radar/core";
import { useState } from "react";
import { fmtPrice } from "@/lib/format";

export const BIAS_STYLE: Record<TradeSetup["bias"], { label: string; cls: string }> = {
  LONG: { label: "▲ LONG", cls: "border-emerald-500/70 bg-emerald-500/15 text-emerald-300" },
  SHORT: { label: "▼ SHORT", cls: "border-rose-500/70 bg-rose-500/15 text-rose-300" },
  WAIT: { label: "⏸ ATTENDRE", cls: "border-slate-600 bg-slate-800/60 text-slate-300" },
};

/** Factor bar: −1 … +1 around a centre line (diverging, neutral grey track). */
function FactorBar({ value }: { value: number }) {
  const w = Math.min(50, Math.abs(value) * 50);
  return (
    <div className="relative h-2 w-28 shrink-0 rounded bg-slate-800" aria-hidden>
      <div className="absolute top-0 h-2 w-px bg-slate-500" style={{ left: "50%" }} />
      <div className={`absolute top-0 h-2 rounded ${value >= 0 ? "bg-emerald-400" : "bg-rose-400"}`} style={value >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />
    </div>
  );
}

export function SetupPlan({ s, compact = false }: { s: TradeSetup; compact?: boolean }) {
  const st = BIAS_STYLE[s.bias];
  const side = s.side;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`rounded border px-2 py-0.5 text-sm font-bold ${st.cls}`}>{st.label}</span>
        <span className="text-slate-400">
          score <strong className="num text-slate-100">{s.score > 0 ? `+${s.score}` : s.score}</strong> · confiance <strong className="num text-slate-100">{s.confidence}</strong>/100 · unité {s.timeframe}
        </span>
      </div>
      {s.bias === "WAIT" && <p className="text-xs text-slate-400">Pas de plan à prendre maintenant. Ci-dessous, le plan {side} si les conditions s&apos;alignent (pour information).</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Cell label="Zone d'entrée" value={`${fmtPrice(s.entry.low)} – ${fmtPrice(s.entry.high)}`} />
        <Cell label={`Stop (${s.stopDistPct} %)`} value={fmtPrice(s.stop)} tone="bad" />
        <Cell label="Objectifs" value={s.targets.map((t) => fmtPrice(t.price)).join(" / ")} tone="good" />
        <Cell label="Gain / risque" value={`${s.riskReward}`} />
        <Cell label="Levier raisonnable max" value={`×${s.maxSafeLeverage}`} />
        <Cell label="Volatilité (ATR)" value={`${s.atrPct} %`} />
        <Cell label="RSI 14" value={s.rsi === null ? "—" : `${s.rsi}`} />
        <Cell label="Compression" value={s.squeeze ? "oui" : "non"} />
      </div>
      <p className="text-xs text-slate-300">🛑 {s.invalidation}</p>
      {!compact && (
        <div>
          <div className="text-xs font-semibold uppercase text-slate-400">Checklist du trader</div>
          <ul className="mt-1 space-y-1.5">
            {s.factors.map((f) => (
              <li key={f.id} className="flex items-start gap-2">
                <FactorBar value={f.value} />
                <span className="text-xs">
                  <span className="font-semibold text-slate-200">{f.label}</span> <span className="text-slate-500">(poids {f.weight})</span> : <span className="text-slate-400">{f.note}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {s.warnings.length > 0 && (
        <ul className="space-y-0.5 text-xs text-amber-300/90">
          {s.warnings.slice(0, compact ? 2 : 8).map((w, i) => (
            <li key={i}>⚠️ {w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-950/40 px-2 py-1.5">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`num text-sm font-semibold ${tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : "text-slate-100"}`}>{value}</div>
    </div>
  );
}

/** Position size calculator: how much to buy so that the stop costs a fixed share of the capital. */
export function PositionCalculator({ s }: { s: TradeSetup }) {
  const [capital, setCapital] = useState(1000);
  const [risk, setRisk] = useState(1);
  const p = positionSize(s, capital, risk);
  const tooMuch = p.leverageNeeded > s.maxSafeLeverage;
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap gap-3">
        <label className="text-xs text-slate-400">
          Capital ($)
          <input type="number" inputMode="decimal" min={0} value={capital} onChange={(e) => setCapital(Math.max(0, Number(e.target.value) || 0))} className="num mt-1 block w-32 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100" />
        </label>
        <label className="text-xs text-slate-400">
          Risque par trade (%)
          <input type="number" inputMode="decimal" min={0.1} max={10} step={0.1} value={risk} onChange={(e) => setRisk(Math.min(10, Math.max(0.1, Number(e.target.value) || 1)))} className="num mt-1 block w-24 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100" />
        </label>
      </div>
      <p className="text-slate-300">
        Si le stop est touché, tu perds <strong className="num">{p.riskUsd.toFixed(2)} $</strong>. Taille de position : <strong className="num">{p.notional.toFixed(2)} $</strong> (≈ {fmtPrice(p.quantity)} unités), soit un levier de{" "}
        <strong className="num">×{p.leverageNeeded.toFixed(2)}</strong>.
      </p>
      {tooMuch && <p className="text-xs text-rose-300">⚠️ Ce levier dépasse le maximum raisonnable (×{s.maxSafeLeverage}) : réduis le risque par trade.</p>}
      <p className="text-[11px] text-slate-500">Règle des traders : ne jamais risquer plus de 1–2 % du capital par position. Frais et glissement non inclus. Pas un conseil.</p>
    </div>
  );
}

"use client";

import type { Opportunity } from "@radar/core";
import { useEffect, useState } from "react";
import { Card, ScoreBar, SignalChips } from "@/components/ui";
import { getJson } from "@/lib/api";
import { fmtCompact, fmtDuration, fmtPct, fmtPrice, fmtRatio, fmtTime, pctClass } from "@/lib/format";
import { useRadarStream } from "@/lib/stream";

interface OppResponse {
  active: Opportunity[];
  recent: Opportunity[];
}

function OpportunityCard({ o, now }: { o: Opportunity; now: number }) {
  const m = o.metrics;
  const move = ((o.price - o.priceAtDetection) / o.priceAtDetection) * 100;
  const accelLabel = m.accelerationPct === null ? "—" : m.accelerationPct >= 1 ? "FORTE" : m.accelerationPct >= 0.5 ? "MOYENNE" : "FAIBLE";
  return (
    <div className={`rounded-lg border p-4 ${o.status === "active" ? "border-emerald-700/50 bg-emerald-500/[0.04]" : "border-slate-800 bg-slate-900/40"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-lg font-bold text-slate-100">{o.productId}</div>
          <div className="num text-sm text-slate-400">
            {fmtPrice(o.price)} · détecté à {fmtTime(o.detectedAt)} ({fmtPrice(o.priceAtDetection)}) ·{" "}
            <span className={pctClass(move)}>{fmtPct(move)}</span> depuis
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] text-slate-500">Opportunity score</div>
          <ScoreBar score={o.score} />
          <div className="text-[11px] text-slate-500">max {o.peakScore}</div>
        </div>
      </div>

      <div className="num mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <div>Mouvement 1m : <span className={pctClass(m.changes["1m"])}>{fmtPct(m.changes["1m"])}</span></div>
        <div>5m : <span className={pctClass(m.changes["5m"])}>{fmtPct(m.changes["5m"])}</span></div>
        <div>Volume : <span className="text-sky-300">{fmtRatio(m.volumeRatio)}</span> <span className="text-slate-500">({fmtCompact(m.volumeRecentQuote)} {m.quoteCurrency}/min)</span></div>
        <div>Accélération : {accelLabel}</div>
        <div>Spread : {m.spreadPct === null ? "—" : `${m.spreadPct.toFixed(3)} %`}</div>
        <div>Profondeur : {fmtCompact(m.topBookDepthQuote)} {m.quoteCurrency}</div>
        <div>Volume 24h : {fmtCompact(m.volume24hQuote)} {m.quoteCurrency}</div>
        <div>Durée : {fmtDuration((o.expiredAt ?? now) - o.detectedAt)}</div>
      </div>

      <div className="mt-3 grid grid-cols-5 gap-2 text-center text-[11px]">
        {(["momentum", "volume", "acceleration", "liquidity", "volatility"] as const).map((k) => (
          <div key={k} className="rounded bg-slate-900 p-1.5">
            <div className="text-slate-500">{k.toUpperCase()}</div>
            <div className="num text-base font-semibold text-slate-200">{o.scores[k]}</div>
          </div>
        ))}
      </div>

      <div className="mt-3">
        <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
          Raisons du signal <SignalChips types={o.signals} />
        </div>
        <ul className="list-inside list-disc text-sm text-slate-300">
          {o.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>

      <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
        <div className="rounded bg-slate-900 p-2">
          <div className="text-[11px] text-slate-500">Tradabilité (liquidité)</div>
          {o.tradable ? (
            <span className="font-semibold text-emerald-400">Liquidité suffisante</span>
          ) : (
            <span className="font-semibold text-amber-300">NON TRADABLE : {o.liquidityIssues.join(", ")}</span>
          )}
        </div>
        <div className="rounded bg-slate-900 p-2">
          <div className="text-[11px] text-slate-500">Stratégie / action proposée</div>
          <span className="text-slate-300">{o.suggestedAction}</span>
        </div>
        <div className="rounded bg-slate-900 p-2">
          <div className="text-[11px] text-slate-500">Risk Engine / frais estimés</div>
          <span className="text-slate-500">Non évalué — Risk Engine et frais en phase ultérieure</span>
        </div>
      </div>
    </div>
  );
}

export default function OpportunitiesPage() {
  const { snapshot } = useRadarStream();
  const [data, setData] = useState<OppResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refresh on every radar tick.
  useEffect(() => {
    getJson<OppResponse>("/api/opportunities")
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [snapshot?.ts]);

  const now = snapshot?.evaluatedAt ?? Date.now();
  return (
    <div className="space-y-6">
      {error && <Card><span className="text-rose-400">{error}</span></Card>}
      <Card title={`Opportunités actives (${data?.active.length ?? 0})`}>
        <div className="grid gap-4 lg:grid-cols-2">
          {data?.active.map((o) => <OpportunityCard key={o.id} o={o} now={now} />)}
        </div>
        {data && data.active.length === 0 && <p className="text-sm text-slate-500">Aucune opportunité active. Le radar surveille le marché.</p>}
      </Card>
      <Card title="Opportunités récentes (expirées)">
        <div className="grid gap-4 lg:grid-cols-2">
          {data?.recent.map((o) => <OpportunityCard key={o.id} o={o} now={now} />)}
        </div>
        {data && data.recent.length === 0 && <p className="text-sm text-slate-500">Aucune pour l&apos;instant.</p>}
      </Card>
    </div>
  );
}

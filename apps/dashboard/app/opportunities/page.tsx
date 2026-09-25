"use client";

import type { Opportunity, StrategyProposal } from "@radar/core";
import { useEffect, useState } from "react";
import { Card, ScoreBar, SignalChips } from "@/components/ui";
import { getJson } from "@/lib/api";
import { fmtCompact, fmtDuration, fmtPct, fmtPrice, fmtRatio, fmtTime, pctClass } from "@/lib/format";
import { useRadarStream } from "@/lib/stream";

interface OppResponse {
  active: Opportunity[];
  recent: Opportunity[];
  proposals: Record<string, StrategyProposal[]>;
}

function Proposals({ list, currency }: { list: StrategyProposal[] | undefined; currency: string }) {
  if (!list || list.length === 0) return <span className="text-slate-500">Aucune stratégie ne couvre ce produit (univers, devise).</span>;
  return (
    <div className="space-y-2">
      {list.map((p) => (
        <div key={p.strategyId}>
          <div className="text-slate-200">{p.strategyName}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {p.conditions.map((c) => (
              <span key={c.label} className={`rounded px-1.5 py-0.5 text-[10px] ${c.passed ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-800 text-slate-400"}`}>
                {c.passed ? "✓" : "✗"} {c.label} ({c.value === null ? "—" : c.value.toFixed(2)})
              </span>
            ))}
          </div>
          <div className="mt-1 text-xs">
            Action : <span className="text-slate-200">{p.action}</span>
            {p.allConditionsMet && (
              <>
                {" "}
                · montant {p.quoteAmount} {currency} · frais estimés aller-retour {p.estimatedFees.toFixed(2)} {currency}
              </>
            )}
          </div>
          {p.risk && (
            <div className={`mt-1 text-xs font-semibold ${p.risk.approved ? "text-emerald-400" : "text-rose-400"}`}>
              Risk Engine : {p.risk.approved ? "APPROVED" : "REJECTED"}
              {!p.risk.approved && <ul className="mt-0.5 list-inside list-disc font-normal text-rose-300/90">{p.risk.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function OpportunityCard({ o, now, proposals }: { o: Opportunity; now: number; proposals?: StrategyProposal[] }) {
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

      <div className="mt-3 grid gap-2 text-sm sm:grid-cols-[1fr_2fr]">
        <div className="rounded bg-slate-900 p-2">
          <div className="text-[11px] text-slate-500">Tradabilité (liquidité)</div>
          {o.tradable ? (
            <span className="font-semibold text-emerald-400">Liquidité suffisante</span>
          ) : (
            <span className="font-semibold text-amber-300">NON TRADABLE : {o.liquidityIssues.join(", ")}</span>
          )}
        </div>
        <div className="rounded bg-slate-900 p-2 text-sm">
          <div className="text-[11px] text-slate-500">Stratégies → action proposée → Risk Engine {o.status !== "active" && "(état actuel du marché)"}</div>
          <Proposals list={proposals} currency={m.quoteCurrency} />
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
          {data?.active.map((o) => <OpportunityCard key={o.id} o={o} now={now} proposals={data.proposals[o.productId]} />)}
        </div>
        {data && data.active.length === 0 && <p className="text-sm text-slate-500">Aucune opportunité active. Le radar surveille le marché.</p>}
      </Card>
      <Card title="Opportunités récentes (expirées)">
        <div className="grid gap-4 lg:grid-cols-2">
          {data?.recent.map((o) => <OpportunityCard key={o.id} o={o} now={now} proposals={data.proposals[o.productId]} />)}
        </div>
        {data && data.recent.length === 0 && <p className="text-sm text-slate-500">Aucune pour l&apos;instant.</p>}
      </Card>
    </div>
  );
}

"use client";

import { Card, ScoreBar } from "@/components/ui";
import { fmtDateTime, fmtDuration, fmtMoney, fmtPct, fmtPrice, pctClass } from "@/lib/format";
import { useRadarStream } from "@/lib/stream";

export default function PositionsPage() {
  const { trading, snapshot } = useRadarStream();
  if (!trading) return <Card><span className="text-slate-400">Connexion…</span></Card>;
  const cur = trading.capital.currency;
  const now = snapshot?.ts ?? Date.now();
  const strategies = new Map(trading.strategies.map((s) => [s.id, s]));

  return (
    <div className="space-y-6">
      {!trading.executionEnabled && (
        <Card>
          <p className="text-sm text-slate-400">
            Mode RADAR : aucune position n&apos;est ouverte. Lance le serveur avec <code className="text-slate-200">MODE=PAPER</code> pour le trading simulé.
          </p>
        </Card>
      )}
      <Card title={`Positions ouvertes (${trading.positions.length}/${trading.limits.maxOpenPositions})`}>
        {trading.positions.length === 0 ? (
          <p className="text-sm text-slate-500">Aucune position ouverte.</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {trading.positions.map((p) => {
              const s = strategies.get(p.strategyId);
              const pnlPct = (p.unrealizedPnl / (p.costQuote * (p.baseQty / p.initialBaseQty))) * 100;
              const distStop = ((p.lastPrice - p.effectiveStop) / p.lastPrice) * 100;
              return (
                <div key={p.id} className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-lg font-bold text-slate-100">{p.productId}</div>
                      <div className="text-xs text-slate-500">
                        {s?.name ?? p.strategyId} · ouverte {fmtDateTime(p.openedAt)} · depuis {fmtDuration(now - p.openedAt)}
                        {p.status === "closing" && <span className="ml-2 font-semibold text-amber-300">sortie en cours…</span>}
                      </div>
                    </div>
                    <div className={`num text-right text-lg font-semibold ${pctClass(p.unrealizedPnl)}`}>
                      {fmtMoney(p.unrealizedPnl, cur, true)}
                      <div className="text-xs">{fmtPct(pnlPct)}</div>
                    </div>
                  </div>
                  <div className="num mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                    <div>Entrée : {fmtPrice(p.entryPrice)}</div>
                    <div>Prix actuel : {fmtPrice(p.lastPrice)}</div>
                    <div>Plus haut : {fmtPrice(p.highestPrice)}</div>
                    <div>Stop (entrée) : {fmtPrice(p.stopLevel)}</div>
                    <div>Trailing : {p.trailingLevel === null ? "désactivé" : fmtPrice(p.trailingLevel)}</div>
                    <div>
                      Sortie à : <span className="font-semibold text-amber-300">{fmtPrice(p.effectiveStop)}</span>{" "}
                      <span className="text-slate-500">({distStop.toFixed(2)} %)</span>
                    </div>
                    <div>Quantité : {p.baseQty}</div>
                    <div>Coût : {fmtMoney(p.costQuote, cur)}</div>
                    <div>Frais d&apos;entrée : {fmtMoney(p.entryFees, cur)}</div>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                    <div className="rounded bg-slate-900 p-2">
                      <div className="text-slate-500">Signal initial → actuel</div>
                      <div className="mt-1 flex items-center gap-3">
                        <ScoreBar score={p.entrySignalScore ?? 0} /> → <ScoreBar score={p.currentScore ?? 0} />
                      </div>
                    </div>
                    <div className="rounded bg-slate-900 p-2">
                      <div className="text-slate-500">Conditions de sortie</div>
                      <div className="text-slate-300">
                        stop −{s?.exit.stopLossPct} %{s?.exit.trailingStopPct ? ` · trailing ${s.exit.trailingStopPct} %` : ""}
                        {p.takeProfitLevel !== null ? ` · take profit ${fmtPrice(p.takeProfitLevel)}` : ""}
                        {p.maxDurationSec !== null ? ` · durée max ${fmtDuration(p.maxDurationSec * 1000)}` : ""}
                      </div>
                    </div>
                  </div>
                  <p className="mt-2 text-[11px] text-slate-500">Raison d&apos;entrée : {p.entryReason}</p>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      {trading.pendingOrders.length > 0 && (
        <Card title="Ordres en cours d'exécution">
          <ul className="text-sm text-slate-300">
            {trading.pendingOrders.map((o) => (
              <li key={o.id}>
                {o.intent.kind} {o.intent.side} {o.intent.productId} — soumis {fmtDateTime(o.submittedAt)}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

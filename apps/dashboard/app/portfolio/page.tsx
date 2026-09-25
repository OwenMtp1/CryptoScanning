"use client";

import type { EquityPoint, TradeRecord } from "@radar/core";
import { useEffect, useState } from "react";
import { PnlChart } from "@/components/PnlChart";
import { Card, Stat } from "@/components/ui";
import { getJson, postAction } from "@/lib/api";
import { fmtDateTime, fmtDuration, fmtMoney, fmtPct, fmtPrice, pctClass } from "@/lib/format";
import { useRadarStream } from "@/lib/stream";

const EXIT_LABEL: Record<string, string> = {
  STOP_LOSS: "Stop loss",
  TRAILING_STOP: "Trailing stop",
  TAKE_PROFIT: "Take profit",
  MAX_DURATION: "Durée max",
};

export default function PortfolioPage() {
  const { trading, snapshot } = useRadarStream();
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const tick = snapshot ? Math.floor(snapshot.ts / 5000) : 0;

  useEffect(() => {
    getJson<TradeRecord[]>("/api/trading/trades?limit=500").then(setTrades, () => {});
    getJson<EquityPoint[]>("/api/trading/equity").then(setEquity, () => {});
  }, [tick]);

  if (!trading) return <Card><span className="text-slate-400">Connexion…</span></Card>;
  const cur = trading.capital.currency;
  const c = trading.capital;
  const p = trading.performance;
  const livePoints = trading.initialized ? [...equity, { ts: snapshot?.ts ?? Date.now(), total: c.total, tradingPnl: p.tradingPnl }] : equity;

  const reset = async () => {
    if (window.prompt("Réinitialiser le portefeuille PAPER ? Tout l'historique paper sera effacé.\nTape RESET pour confirmer :") !== "RESET") return;
    try {
      await postAction("/api/trading/reset", { confirm: "RESET" });
    } catch (e) {
      window.alert(`Refusé : ${(e as Error).message}`);
    }
  };

  return (
    <div className="space-y-6">
      {!trading.executionEnabled && (
        <Card>
          <p className="text-sm text-slate-400">
            Mode RADAR : portefeuille <strong>virtuel</strong> (utilisé pour évaluer les propositions avec le Risk Engine), jamais modifié. Pour simuler des trades :{" "}
            <code className="text-slate-200">MODE=PAPER</code>.
          </p>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card title={trading.executionEnabled ? "Portfolio bot (paper)" : "Portfolio virtuel"}>
          {!trading.initialized ? (
            <p className="text-sm text-slate-500">En attente des prix : {trading.waitingFor.join(", ")}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Stat label="Total portefeuille" value={fmtMoney(c.total, cur)} hint={`initial ${fmtMoney(trading.initialValue, cur)}`} />
                <Stat label="Capital protégé" value={fmtMoney(c.protected, cur)} hint="jamais utilisé par le bot" />
                <Stat label="Capital tradable" value={fmtMoney(c.tradable, cur)} hint="total − protégé" />
                <Stat label="Capital engagé" value={fmtMoney(c.engaged, cur)} hint="positions ouvertes" />
                <Stat label="Capital disponible" value={fmtMoney(c.available, cur)} tone="good" hint="max pour une entrée" />
                <Stat label="Liquidités" value={fmtMoney(c.cash, cur)} />
              </div>
              <table className="num mt-4 w-full text-sm">
                <thead className="text-left text-xs text-slate-500">
                  <tr>
                    <th className="py-1">Actif</th>
                    <th className="py-1 text-right">Quantité</th>
                    <th className="py-1 text-right">dont positions</th>
                    <th className="py-1 text-right">Prix</th>
                    <th className="py-1 text-right">Valeur</th>
                    <th className="py-1 text-right">Minimum</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-slate-800">
                    <td className="py-1 font-semibold">{cur}</td>
                    <td className="py-1 text-right" colSpan={3}>liquidités</td>
                    <td className="py-1 text-right">{fmtMoney(c.cash, cur)}</td>
                    <td />
                  </tr>
                  {c.holdings
                    .filter((h) => h.qty > 0 || h.minValue)
                    .map((h) => (
                      <tr key={h.asset} className="border-t border-slate-800">
                        <td className="py-1 font-semibold">{h.asset}</td>
                        <td className="py-1 text-right">{h.qty.toPrecision(6)}</td>
                        <td className="py-1 text-right text-slate-400">{h.positionQty ? h.positionQty.toPrecision(6) : "—"}</td>
                        <td className="py-1 text-right">{fmtPrice(h.price)}</td>
                        <td className="py-1 text-right">{fmtMoney(h.value, cur)}</td>
                        <td className={`py-1 text-right ${h.belowMin ? "text-amber-300" : "text-slate-500"}`} title={h.belowMin ? "Valeur de la réserve sous le minimum (effet du prix : le bot ne vend jamais la réserve)" : ""}>
                          {h.minValue ? `${fmtMoney(h.minValue, cur)}${h.belowMin ? " ⚠" : ""}` : "—"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </>
          )}
        </Card>

        <Card title="Performance">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="P&L trading" value={fmtMoney(p.tradingPnl, cur, true)} tone={p.tradingPnl > 0.005 ? "good" : p.tradingPnl < -0.005 ? "bad" : "default"} hint={`réalisé ${fmtMoney(p.realizedPnl, cur, true)}`} />
            <Stat label="P&L %" value={fmtPct(trading.initialValue - c.protected > 0 ? (p.tradingPnl / (trading.initialValue - c.protected)) * 100 : null)} hint="vs capital tradable initial" />
            <Stat label="Win rate" value={p.winRatePct === null ? "—" : `${p.winRatePct.toFixed(0)} %`} hint={`${p.wins} gagnant(s) / ${p.losses} perdant(s)`} />
            <Stat label="Trades" value={p.trades} />
            <Stat label="Profit moyen" value={fmtMoney(p.avgWin, cur, true)} />
            <Stat label="Perte moyenne" value={fmtMoney(p.avgLoss, cur, true)} />
            <Stat label="Profit factor" value={p.profitFactor === null ? "—" : p.profitFactor.toFixed(2)} />
            <Stat label="Max drawdown" value={fmtMoney(p.maxDrawdown, cur)} />
            <Stat label="Frais cumulés" value={fmtMoney(p.totalFees, cur)} hint={`taker ${trading.fees.takerFeePct} % (hypothèse)`} />
            <Stat label="Slippage cumulé" value={fmtMoney(p.totalSlippage, cur)} />
            <Stat label="Positions ouvertes" value={trading.positions.length} hint={`latent ${fmtMoney(p.unrealizedPnl, cur, true)}`} />
            <Stat label="Risque" value={trading.riskLevel} tone={trading.riskLevel === "LOW" ? "good" : trading.riskLevel === "MEDIUM" ? "warn" : "bad"} />
          </div>
          <p className="mt-3 text-[11px] text-slate-500">
            Frais : {trading.fees.assumption}. Un aller-retour coûte environ {(trading.fees.takerFeePct * 2).toFixed(1)} % : une stratégie doit gagner plus que cela pour être rentable.
          </p>
        </Card>
      </div>

      <Card title="P&L trading cumulé">
        <PnlChart points={livePoints} currency={cur} />
      </Card>

      <Card title={`Trades clôturés (${trades.length})`}>
        <div className="overflow-x-auto rounded border border-slate-800">
          <table className="num w-full text-xs">
            <thead className="bg-slate-900 text-left text-slate-400">
              <tr>
                {["Fermé", "Actif", "Stratégie", "Entrée", "Sortie", "Plus haut", "Qté", "Coût", "P&L", "P&L %", "Frais", "Slippage", "Durée", "Score", "Sortie", "Portefeuille"].map((h, i) => (
                  <th key={`${h}${i}`} className="whitespace-nowrap px-2 py-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id} className="border-t border-slate-800/70 hover:bg-slate-800/40" title={`Entrée : ${t.entryReason}`}>
                  <td className="whitespace-nowrap px-2 py-1.5 text-slate-500">{fmtDateTime(t.closedAt)}</td>
                  <td className="px-2 py-1.5 font-semibold">{t.productId}</td>
                  <td className="px-2 py-1.5 text-slate-400">{t.strategyId}</td>
                  <td className="px-2 py-1.5">{fmtPrice(t.entryPrice)}</td>
                  <td className="px-2 py-1.5">{fmtPrice(t.exitPrice)}</td>
                  <td className="px-2 py-1.5">{fmtPrice(t.highestPrice)}</td>
                  <td className="px-2 py-1.5">{t.baseQty.toPrecision(5)}</td>
                  <td className="px-2 py-1.5">{fmtMoney(t.costQuote, cur)}</td>
                  <td className={`px-2 py-1.5 font-semibold ${pctClass(t.pnl)}`}>{fmtMoney(t.pnl, cur, true)}</td>
                  <td className={`px-2 py-1.5 ${pctClass(t.pnlPct)}`}>{fmtPct(t.pnlPct)}</td>
                  <td className="px-2 py-1.5">{fmtMoney(t.fees, cur)}</td>
                  <td className="px-2 py-1.5">{fmtMoney(t.slippageQuote, cur)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">{fmtDuration(t.closedAt - t.openedAt)}</td>
                  <td className="px-2 py-1.5">{t.entrySignalScore ?? "—"}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">{EXIT_LABEL[t.exitReason] ?? t.exitReason}</td>
                  <td className="px-2 py-1.5">{fmtMoney(t.portfolioValueAfter, cur)}</td>
                </tr>
              ))}
              {trades.length === 0 && (
                <tr>
                  <td colSpan={16} className="px-2 py-6 text-center text-slate-500">
                    Aucun trade clôturé.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {trading.executionEnabled && (
        <div className="text-right">
          <button onClick={reset} className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-800">
            Réinitialiser le portefeuille paper…
          </button>
        </div>
      )}
    </div>
  );
}

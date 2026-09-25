"use client";

import type { SignalConfig, TradingConfig } from "@radar/core";
import { useEffect, useState, type ReactNode } from "react";
import { Card } from "@/components/ui";
import { getJson } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { useRadarStream } from "@/lib/stream";

interface PublicConfig {
  mode: string;
  implementedModes: string[];
  dataSource: "simulated" | "coinbase";
  quoteCurrencies: string[];
  maxProducts: number;
  evalIntervalMs: number;
  signalConfig: SignalConfig;
  signalConfigSource: "file" | "defaults";
  tradingConfig: TradingConfig;
  tradingConfigSource: "file" | "defaults";
  coinbase: {
    restBaseUrl: string;
    wsUrl: string;
    restMaxRps: number;
    wsProductsPerConnection: number;
    authentication: string;
    apiKeyConfigured: boolean;
    keyPermissions: null | Record<string, unknown>;
    tradabilityVerified: boolean;
    account?: {
      configured: boolean;
      state: "disabled" | "connecting" | "connected" | "refused" | "error";
      message: string | null;
      keyName: string | null;
      algorithm: string | null;
      permissions: { canView: boolean; canTrade: boolean; canTransfer: boolean; portfolioUuid: string | null; portfolioType: string | null } | null;
      balances: { currency: string; available: number; hold: number }[];
      fees: { pricingTier: string | null; takerFeePct: number | null; makerFeePct: number | null; volume30d: number | null } | null;
      accountProducts: number | null;
      lastSyncAt: number | null;
    };
  };
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-800/70 py-1.5 text-sm">
      <span className="text-slate-400">{k}</span>
      <span className="num text-right text-slate-200">{v}</span>
    </div>
  );
}

function Later({ children }: { children: ReactNode }) {
  return <p className="text-sm text-slate-500">{children}</p>;
}

export default function SettingsPage() {
  const { status } = useRadarStream();
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJson<PublicConfig>("/api/config").then(setCfg, (e: Error) => setError(e.message));
  }, []);

  if (error) return <Card><span className="text-rose-400">{error}</span></Card>;
  if (!cfg) return <Card><span className="text-slate-400">Chargement…</span></Card>;
  const s = cfg.signalConfig;
  const t = cfg.tradingConfig;
  const cur = t.portfolio.currency;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Lecture seule en phase 1. La configuration se modifie dans <code className="text-slate-300">.env</code> et{" "}
        <code className="text-slate-300">config/signal-config.json</code>, <code className="text-slate-300">config/trading.json</code> puis redémarrage du serveur (valeurs validées par Zod au démarrage).
      </p>
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <Card title="Général">
          <Row k="Mode" v={<span className="font-semibold text-sky-300">{cfg.mode}</span>} />
          <Row k="Modes implémentés" v={cfg.implementedModes.join(", ")} />
          <Row k="LIVE" v={<span className="text-slate-500">non disponible (phase ultérieure, confirmations multiples)</span>} />
          <Row k="Source des données" v={cfg.dataSource === "simulated" ? <span className="text-amber-300">SIMULÉE</span> : "Coinbase (public)"} />
          <Row k="Devises de cotation" v={cfg.quoteCurrencies.join(", ")} />
          <Row k="Produits max." v={cfg.maxProducts} />
          <Row k="Évaluation" v={`toutes les ${cfg.evalIntervalMs} ms`} />
        </Card>

        <Card title="Coinbase">
          <Row k="API REST" v={<span className="font-mono text-xs">{cfg.coinbase.restBaseUrl}</span>} />
          <Row k="WebSocket" v={<span className="font-mono text-xs">{cfg.coinbase.wsUrl}</span>} />
          <Row k="Statut du flux" v={status ? `${status.feed.state} (${status.feed.openConnections}/${status.feed.connections})` : "—"} />
          <Row k="Dernier heartbeat" v={status?.feed.lastHeartbeatAt ? fmtDateTime(status.feed.lastHeartbeatAt) : "—"} />
          <Row k="Reconnexions / trous de séquence" v={status ? `${status.feed.reconnects} / ${status.feed.sequenceGaps}` : "—"} />
          <Row k="Limite REST (client)" v={`${cfg.coinbase.restMaxRps} req/s`} />
          <Row k="Produits par connexion WS" v={cfg.coinbase.wsProductsPerConnection} />
          <Row k="Authentification" v={cfg.coinbase.authentication} />
          {(() => {
            const a = cfg.coinbase.account;
            const state = a?.state ?? "disabled";
            const tone = { connected: "text-emerald-400", connecting: "text-sky-300", disabled: "text-slate-400", refused: "text-rose-400", error: "text-rose-400" }[state];
            const label = { connected: "connecté (lecture seule)", connecting: "connexion…", disabled: "aucune clé (données publiques)", refused: "CLÉ REFUSÉE", error: "erreur" }[state];
            const p = a?.permissions;
            return (
              <>
                <Row k="Compte" v={<span className={`font-semibold ${tone}`}>{label}</span>} />
                {a?.message && <p className={`py-1 text-xs ${state === "refused" || state === "error" ? "text-rose-300" : "text-slate-500"}`}>{a.message}</p>}
                {a?.keyName && <Row k="Clé" v={`${a.keyName} (${a.algorithm})`} />}
                <Row
                  k="Permissions détectées"
                  v={p ? `View ${p.canView ? "✓" : "✗"} · Trade ${p.canTrade ? "✓" : "✗"} · Transfer ${p.canTransfer ? "⚠ OUI" : "✗ (bien)"}` : "—"}
                />
                <Row k="Portfolio" v={p ? `${p.portfolioType ?? "?"} ${p.portfolioUuid ? `(${p.portfolioUuid.slice(0, 8)}…)` : ""}` : "—"} />
                <Row k="Soldes" v={a?.balances?.length ? a.balances.map((b) => `${b.available} ${b.currency}`).join(" · ") : "—"} />
                <Row
                  k="Palier de frais"
                  v={a?.fees ? `${a.fees.pricingTier ?? "?"} — taker ${a.fees.takerFeePct?.toFixed(3) ?? "?"} % / maker ${a.fees.makerFeePct?.toFixed(3) ?? "?"} %` : "—"}
                />
                <Row k="Produits disponibles pour le compte" v={a?.accountProducts ?? "—"} />
                <Row k="Tradabilité compte/région" v={cfg.coinbase.tradabilityVerified ? "vérifiée (liste authentifiée)" : <span className="text-amber-300">non vérifiée</span>} />
                <Row k="Passage d'ordres réels" v={<span className="text-slate-500">non implémenté (phase LIVE)</span>} />
              </>
            );
          })()}
        </Card>

        <Card title={`Stratégie / signaux (${cfg.signalConfigSource === "file" ? "fichier" : "défauts"})`}>
          <Row k="Seuils de hausse 10s / 30s / 1m / 5m" v={`${s.surgeThresholdPct["10s"]} / ${s.surgeThresholdPct["30s"]} / ${s.surgeThresholdPct["1m"]} / ${s.surgeThresholdPct["5m"]} %`} />
          <Row k="Seuil de volume" v={`${s.volume.spikeRatio}x la baseline (${s.volume.recentWindowSec}s vs ${s.volume.baselineWindowSec}s)`} />
          <Row k="Accélération min." v={`${s.acceleration.minAccelerationPct} % (${s.acceleration.segments} × ${s.acceleration.segmentSec}s)`} />
          <Row k="Score minimum (opportunité)" v={s.opportunity.minScore} />
          <Row k="Spread max." v={`${s.liquidity.maxSpreadPct} %`} />
          <Row k="Profondeur min. (top-of-book)" v={s.liquidity.minTopBookDepthQuote} />
          <Row k="Volume 24h min." v={s.liquidity.min24hVolumeQuote} />
          <Row k="Cooldown des signaux" v={`${s.signalCooldownSec} s`} />
          <Row k="Données obsolètes après" v={`${s.feedStaleAfterSec} s`} />
          <Row
            k="Poids M / V / A / L / Vol"
            v={`${s.scoring.weights.momentum} / ${s.scoring.weights.volume} / ${s.scoring.weights.acceleration} / ${s.scoring.weights.liquidity} / ${s.scoring.weights.volatility}`}
          />
        </Card>

        <Card title={`Capital (${cfg.tradingConfigSource === "file" ? "fichier" : "défauts"})`}>
          <Row k="Capital initial paper" v={`${t.portfolio.initial.cash} ${cur} liquidités + ${Object.entries(t.portfolio.initial.holdings).map(([a, v]) => `${v} ${a}`).join(" + ")}`} />
          <Row k="Capital protégé" v={`${t.portfolio.protectedCapital} ${cur}`} />
          <Row k="Capital tradable" v="total − protégé (dynamique)" />
          <Row k="Minimums conservés" v={Object.entries(t.portfolio.minHoldingsValue).map(([a, v]) => `${a} ${v} ${cur}`).join(", ") || "—"} />
          <Row k="Devise de compte" v={cur} />
        </Card>
        <Card title="Risque (Risk Engine)">
          <Row k="Max par trade" v={`${t.risk.maxTradeQuote} ${cur}`} />
          <Row k="Positions max." v={t.risk.maxOpenPositions} />
          <Row k="Perte max. 24 h / 7 j" v={`${t.risk.maxDailyLossQuote} / ${t.risk.maxWeeklyLossQuote} ${cur}`} />
          <Row k="Trades max. / h / 24 h" v={`${t.risk.maxTradesPerHour} / ${t.risk.maxTradesPerDay}`} />
          <Row k="Cooldown après perte" v={`${t.risk.cooldownAfterLossSec} s`} />
          <Row k="Exposition max. par actif / totale" v={`${t.risk.maxExposurePerAssetQuote} / ${t.risk.maxTotalExposureQuote} ${cur}`} />
          <Row k="Spread max. / profondeur min." v={`${t.risk.maxSpreadPct} % / ${t.risk.minTopBookDepthQuote} ${cur}`} />
          <Row k="Volume 24 h min." v={`${t.risk.min24hVolumeQuote} ${cur}`} />
          <Row k="Fraîcheur max. (entrées / sorties)" v={`${t.risk.maxDataAgeSec} s / ${t.risk.maxExitDataAgeSec} s`} />
          <Row k="Slippage max. estimé / réalisé" v={`${t.risk.maxEstimatedSlippagePct} % / ${t.risk.maxRealizedSlippagePct} %`} />
          <Row k="Erreurs consécutives max." v={t.risk.maxConsecutiveErrors} />
        </Card>
        <Card title="Simulation paper">
          <Row k="Frais taker" v={<span className="text-amber-300">{t.paper.takerFeePct} % (hypothèse non vérifiée)</span>} />
          <Row k="Latence simulée" v={`${t.paper.latencyMs[0]}–${t.paper.latencyMs[1]} ms`} />
          <Row k="Slippage aléatoire / impact" v={`${t.paper.baseSlippageBps} bps / ${t.paper.impactPctPerDepth} % par profondeur`} />
          <Row k="Exécution partielle au-delà de" v={`${t.paper.maxDepthMultiple}× la profondeur top-of-book`} />
          <Row k="Probabilité d'ordre non exécuté" v={`${(t.paper.unfilledProbability * 100).toFixed(1)} %`} />
        </Card>
        {t.strategies.map((st) => (
          <Card key={st.id} title={`Stratégie : ${st.name}${st.enabled ? "" : " (désactivée)"}`}>
            <Row k="SI" v={st.entry.conditions.map((c) => `${c.metric}${c.window ? ` ${c.window}` : ""} ${c.op} ${c.value}`).join(" ET ")} />
            <Row k="Univers" v={`${st.universe.quoteCurrencies.join(", ")}${st.universe.excludeBases.length ? ` sauf ${st.universe.excludeBases.join(", ")}` : ""}`} />
            <Row k="ALORS" v={`ouvrir ${st.sizing.quoteAmount} ${cur} max.`} />
            <Row k="Stop / trailing / take profit" v={`−${st.exit.stopLossPct} % / ${st.exit.trailingStopPct ?? "—"} % / ${st.exit.takeProfitPct ?? "—"} %`} />
            <Row k="Durée max." v={st.exit.maxDurationSec ? `${st.exit.maxDurationSec} s` : "—"} />
            <Row
              k="Après sortie (rotation)"
              v={
                st.afterExit.rotation.enabled
                  ? `${Object.entries(st.afterExit.rotation.allocations).map(([a, v]) => `${v} % ${a}`).join(" / ")} du ${st.afterExit.rotation.mode === "proceeds" ? "capital récupéré" : "profit uniquement"}`
                  : "désactivée"
              }
            />
            <Row k="Cooldown par produit" v={`${st.cooldownPerProductSec} s`} />
          </Card>
        ))}
        <Card title="Notifications">
          <Later>Discord / Telegram : phase ultérieure. Les événements (🚨 ⚡ 🛑 💰 🔴 ⚠️) sont déjà journalisés et visibles dans le dashboard.</Later>
        </Card>
      </div>
    </div>
  );
}

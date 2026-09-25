"use client";

import type { SignalConfig } from "@radar/core";
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
  coinbase: {
    restBaseUrl: string;
    wsUrl: string;
    restMaxRps: number;
    wsProductsPerConnection: number;
    authentication: string;
    apiKeyConfigured: boolean;
    keyPermissions: null | Record<string, unknown>;
    tradabilityVerified: boolean;
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

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Lecture seule en phase 1. La configuration se modifie dans <code className="text-slate-300">.env</code> et{" "}
        <code className="text-slate-300">config/signal-config.json</code> puis redémarrage du serveur (valeurs validées par Zod au démarrage).
      </p>
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <Card title="Général">
          <Row k="Mode" v={<span className="font-semibold text-sky-300">{cfg.mode}</span>} />
          <Row k="Modes implémentés" v={cfg.implementedModes.join(", ")} />
          <Row k="PAPER / LIVE" v={<span className="text-slate-500">non disponibles (phases ultérieures)</span>} />
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
          <Row k="Clé API" v={cfg.coinbase.apiKeyConfigured === true ? "configurée" : "aucune (non requise)"} />
          <Row k="Permissions détectées" v={cfg.coinbase.keyPermissions ? JSON.stringify(cfg.coinbase.keyPermissions) : "— (pas de clé)"} />
          <Row k="Portfolio" v="— (pas de clé)" />
          <Row k="Tradabilité compte/région" v={cfg.coinbase.tradabilityVerified ? "vérifiée" : <span className="text-amber-300">non vérifiée</span>} />
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
          <Row k="Stop loss / trailing / take profit" v={<span className="text-slate-500">Strategy Engine (phase ultérieure)</span>} />
        </Card>

        <Card title="Capital">
          <Later>Capital maximum, protégé et tradable : configurables avec le Paper Trading et le Risk Engine.</Later>
        </Card>
        <Card title="Risque">
          <Later>Max par trade, perte quotidienne max., positions max., trades max., cooldown : Risk Engine (phase ultérieure).</Later>
        </Card>
        <Card title="Rotation & notifications">
          <Later>Rotation BTC/ETH et notifications Discord/Telegram : phases ultérieures.</Later>
        </Card>
      </div>
    </div>
  );
}

/**
 * Human-readable French labels shared by the site and the Discord bot (so both say the same thing).
 */
import type { IntelKind, IntelSource } from "./types.js";

export const KIND_LABEL: Record<IntelKind, string> = {
  PUMP_EARLY: "Décollage",
  DUMP_EARLY: "Chute rapide",
  VOLUME_SURGE: "Volume anormal",
  BREAKOUT_24H_HIGH: "Casse plus haut 24 h",
  BREAKDOWN_24H_LOW: "Casse plus bas 24 h",
  TOP_MOVER_1H: "Top hausse 1 h",
  CRASH_1H: "Krach 1 h",
  VOLUME_MCAP_ANOMALY: "Volume / capi. anormal",
  NEAR_ATH: "Proche record",
  TRENDING_ENTRY: "Entrée tendances",
  FUNDING_EXTREME_LONG: "Funding extrême (longs)",
  FUNDING_EXTREME_SHORT: "Funding extrême (shorts)",
  OPEN_INTEREST_SURGE: "Open interest ↑",
  DEX_NEW_POOL_TRACTION: "Nouveau jeton DEX",
  DEX_TRENDING_PUMP: "Pump DEX",
  DEX_RUG_RISK: "Risque de rug",
  NEWS_BULLISH: "Actu positive",
  NEWS_BEARISH: "Actu négative",
  NEW_LISTING: "🆕 Nouveau listing",
  LIQUIDATIONS_LONG: "Liquidations des longs",
  LIQUIDATIONS_SHORT: "Liquidations des shorts",
  SOCIAL_BUZZ: "Buzz Reddit",
  LEVERAGE_LONG: "Levier : LONG",
  LEVERAGE_SHORT: "Levier : SHORT",
  SETUP_LONG: "Setup LONG",
  SETUP_SHORT: "Setup SHORT",
  TREND_UP: "🧭 Avis haussier",
  TREND_DOWN: "🧭 Avis baissier",
  TREND_EXIT: "🧭 Fin d'avis",
  CONFLUENCE: "CONFLUENCE",
};

export const SOURCE_LABEL: Record<IntelSource, string> = {
  binance: "Binance",
  coinbase: "Coinbase",
  coingecko: "CoinGecko",
  trending: "Tendances",
  derivatives: "Dérivés",
  dex: "DEX",
  news: "Actus",
  social: "Reddit",
  leverage: "Levier",
  exchanges: "Autres CEX",
  setup: "Setup",
  verdict: "Avis de tendance",
};

export function fmtBig(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(x)}`;
}

export const METRIC_LABEL: Record<string, string> = {
  change5m: "5 min",
  change15m: "15 min",
  change1h: "1 h",
  change24h: "24 h",
  change7d: "7 j",
  volumeRatio1h: "vol 1 h",
  volume24hUsd: "vol 24 h",
  marketCapUsd: "capi",
  volumeMcap: "vol/capi",
  fundingRatePct: "funding",
  openInterestUsd: "OI",
  openInterestChangePct: "Δ OI",
  reserveUsd: "liquidité",
  volume1hUsd: "vol 1 h",
  buys1h: "achats 1 h",
  sells1h: "ventes 1 h",
  poolAgeHours: "âge pool",
  takerBuyPct: "achats agressifs %",
  vol5m: "volatilité 5 min",
  liquidatedUsd5m: "liquidé 5 min",
  mentions1h: "mentions 1 h",
  maxLeverage: "levier max",
  score: "score",
  rank: "rang",
  trendingRank: "tendance #",
  athChangePct: "vs record",
  feeds: "médias",
};

/** Human-readable metric chips for a signal. */
export function metricChips(m: Record<string, number | string | null>): { label: string; value: string; tone: "up" | "down" | "flat" }[] {
  const out: { label: string; value: string; tone: "up" | "down" | "flat" }[] = [];
  for (const [k, v] of Object.entries(m)) {
    const label = METRIC_LABEL[k];
    if (!label || v === null || v === undefined || v === "") continue;
    if (typeof v !== "number") continue;
    let value: string;
    let tone: "up" | "down" | "flat" = "flat";
    if (k.startsWith("change") || k === "openInterestChangePct" || k === "athChangePct") {
      value = `${v > 0 ? "+" : ""}${v.toFixed(2)} %`;
      tone = v > 0 ? "up" : v < 0 ? "down" : "flat";
    } else if (k === "fundingRatePct") value = `${v.toFixed(4)} %`;
    else if (k.endsWith("Usd")) value = fmtBig(v);
    else if (k === "volumeRatio1h") value = `${v.toFixed(1)}x`;
    else if (k === "volumeMcap") value = v.toFixed(2);
    else if (k === "poolAgeHours") value = `${v.toFixed(1)} h`;
    else value = String(Math.round(v * 100) / 100);
    out.push({ label, value, tone });
  }
  return out.slice(0, 7);
}

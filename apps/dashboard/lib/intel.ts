import type { CoinRow, Direction, IntelKind, IntelSignal, IntelSource, KindStats, NewsItem, SourceHealth, TrackedSignal } from "@radar/core";

export type FeedSignal = IntelSignal & { hitRate1h?: number | null };
export interface MarketContextView {
  btcChange1h: number | null;
  btcChange24h: number | null;
  regime: "hausse" | "baisse" | "calme" | "inconnu";
  note: string;
}
export interface FeedResponse {
  signals: FeedSignal[];
  counts: { lastHour: number; bullish: number; bearish: number; confluences: number; universe: number };
  market?: MarketContextView;
}
export interface LeverageMarketView {
  productId: string;
  coin: string;
  name: string;
  venue: string | null;
  maxLeverage: number | null;
  price: number | null;
  change24h: number | null;
  fundingPct: number | null;
  openInterest: number | null;
  volume24hUsd: number | null;
  url: string;
  score: number;
  bias: "LONG" | "SHORT" | "NEUTRE";
  reasons: string[];
  anomalies: string[];
  liquidationMovePct: number | null;
  context: { change15m: number | null; change1h: number | null; takerBuyRatio: number | null; binanceFundingPct: number | null; longShortRatio: number | null; oiChangePct: number | null };
}
export interface LeverageResponse {
  at: number | null;
  markets: LeverageMarketView[];
  context: MarketContextView | null;
  unavailable?: boolean;
}
export type UniverseRow = CoinRow & { signals24h: number; lastSignal: { kind: IntelKind; direction: Direction; strength: number; ts: number } | null };
export interface UniverseResponse {
  total: number;
  offset: number;
  rows: UniverseRow[];
}
export interface CoinDetail {
  row: CoinRow | null;
  signals: FeedSignal[];
  news: NewsItem[];
  outcomes: TrackedSignal[];
}
export interface PerformanceResponse {
  horizonsMin: number[];
  hitThresholdPct: number;
  stats: KindStats[];
  recent: TrackedSignal[];
}
export interface SourcesResponse {
  sources: SourceHealth[];
  discord: {
    configured: boolean;
    enabled: boolean;
    state: string;
    lastSentAt: number | null;
    sentLastHour: number;
    maxPerHour: number;
    queued: number;
    digestPending: number;
    nextDigestAt: number | null;
    lastError: string | null;
    pausedUntil: number | null;
    minStrength: number;
  } | null;
  coingecko?: {
    plan: string;
    keyConfigured: boolean;
    budget: { month: string; used: number; monthly: number; remaining: number; allowedPerHour: number; lastMinute: number; perMinute: number };
    stretch: number;
    schedule: { id: string; everyMin: number | null; lastRunAt: number | null; nextAt: number | null }[];
  } | null;
  binanceFeed?: { pairs: number; messages: number; decodeErrors: number; connected: boolean; lastMessageAt: number | null } | null;
  newsFeeds?: { name: string; url: string; lang: string; ok: boolean | null; lastSuccessAt: number | null; lastError: string | null; items: number }[];
  simulated?: boolean;
  /** Live website (browser runtime + Cloudflare functions). */
  web?: boolean;
  discordWorker?: {
    configured?: boolean;
    error?: string;
    status?: {
      lastRunAt?: number | null;
      loop?: string;
      signals24h?: number;
      errors?: string[];
      relay?: { configured: boolean; received: number; lastAt: number | null };
      config?: { siteUrl: string | null; webhookConfigured: boolean; minStrength: number };
      discord?: Record<string, { directions: string[]; state: string; sentLastHour: number; lastSentAt: number | null; lastError: string | null }>;
      message?: string;
    };
  } | null;
  relay?: { keySet: boolean; sent: number; rejected: number; queued: number; rejectReasons: Record<string, number>; lastOkAt: number | null; lastError: string | null };
}

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
  CONFLUENCE: "CONFLUENCE",
};

export const SOURCE_LABEL: Record<IntelSource | "discord", string> = {
  binance: "Binance",
  coinbase: "Coinbase",
  coingecko: "CoinGecko",
  trending: "Tendances",
  derivatives: "Dérivés",
  dex: "DEX",
  news: "Actus",
  social: "Reddit",
  leverage: "Levier",
  discord: "Discord",
};

export const SOURCE_CLS: Record<IntelSource, string> = {
  binance: "bg-yellow-500/15 text-yellow-300",
  coinbase: "bg-blue-500/15 text-blue-300",
  coingecko: "bg-lime-500/15 text-lime-300",
  trending: "bg-fuchsia-500/15 text-fuchsia-300",
  derivatives: "bg-orange-500/15 text-orange-300",
  dex: "bg-violet-500/15 text-violet-300",
  news: "bg-cyan-500/15 text-cyan-300",
  social: "bg-rose-500/15 text-rose-300",
  leverage: "bg-amber-500/20 text-amber-200",
};

export const ALL_SOURCES: IntelSource[] = ["binance", "coinbase", "coingecko", "trending", "derivatives", "dex", "news", "social", "leverage"];

export const dirCls = (d: Direction) => (d === "bullish" ? "text-emerald-400" : d === "bearish" ? "text-rose-400" : "text-slate-400");
export const dirIcon = (d: Direction) => (d === "bullish" ? "▲" : d === "bearish" ? "▼" : "•");

export function fmtAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} j`;
}

export function fmtUsd(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  if (x >= 1) return `$${x.toLocaleString("en-US", { maximumFractionDigits: x >= 1000 ? 0 : 4 })}`;
  return `$${x.toPrecision(4)}`;
}

export function fmtBig(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(x)}`;
}

const METRIC_LABEL: Record<string, string> = {
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

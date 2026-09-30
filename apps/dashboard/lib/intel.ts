import { KIND_LABEL, METRIC_LABEL, SOURCE_LABEL as CORE_SOURCE_LABEL, fmtBig, metricChips } from "@radar/core";
export { KIND_LABEL, METRIC_LABEL, fmtBig, metricChips };
import type { CoinRow, Direction, IntelKind, IntelSignal, IntelSource, KindStats, NewsItem, SourceHealth, TrackedSignal } from "@radar/core";

export type FeedSignal = IntelSignal & { hitRate1h?: number | null; discord?: string | null };

/** What happened to a signal on Discord, in words (null = unknown, e.g. local server). */
export function discordMarkLabel(m: string | null | undefined): { text: string; tone: "ok" | "wait" | "off" | "bad" } | null {
  if (!m) return null;
  if (m === "sent") return { text: "✓ envoyé sur Discord", tone: "ok" };
  if (m === "queued") return { text: "⏳ en route vers Discord", tone: "wait" };
  if (m === "dup") return { text: "Discord : déjà envoyé (même événement, même source, < 30 min)", tone: "off" };
  if (m === "filtered") return { text: "Discord : écarté par tes réglages (page Discord)", tone: "bad" };
  if (m === "nokey") return { text: "Discord : non envoyé, code de relais absent sur cet appareil", tone: "bad" };
  if (m === "cold") return { text: "Discord : bot en démarrage (1re analyse)", tone: "off" };
  if (m === "nochannel") return { text: "Discord : aucun salon pour ce sens", tone: "bad" };
  if (m.startsWith("refused:")) return { text: `Discord : refusé (${m.slice(8)})`, tone: "bad" };
  return { text: `Discord : ${m}`, tone: "off" };
}
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
  origin?: "bot" | "site";
  /** Shown from this browser's last visit while a fresh reading loads. */
  cached?: boolean;
  /** Every source was tried (an empty list is then final, with the reasons). */
  tried?: boolean;
  sources?: string[];
  errors?: string[];
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
  relay?: { keySet: boolean; autoRelay?: boolean; sent: number; rejected: number; queued: number; rejectReasons: Record<string, number>; lastOkAt: number | null; lastError: string | null };
}


export const SOURCE_LABEL: Record<IntelSource | "discord", string> = { ...CORE_SOURCE_LABEL, discord: "Discord" };

export const SOURCE_CLS: Record<IntelSource, string> = {
  binance: "bg-yellow-500/15 text-yellow-300",
  coinbase: "bg-blue-500/15 text-blue-300",
  coingecko: "bg-lime-500/15 text-lime-300",
  trending: "bg-fuchsia-500/15 text-fuchsia-300",
  derivatives: "bg-orange-500/15 text-orange-300",
  dex: "bg-violet-500/15 text-violet-300",
  news: "bg-cyan-500/15 text-cyan-300",
  social: "bg-rose-500/15 text-rose-300",
  exchanges: "bg-teal-500/15 text-teal-300",
  setup: "bg-indigo-500/20 text-indigo-200",
  leverage: "bg-amber-500/20 text-amber-200",
};

export const ALL_SOURCES: IntelSource[] = ["binance", "coinbase", "exchanges", "coingecko", "trending", "derivatives", "dex", "news", "social", "leverage", "setup"];

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




/** Only http(s) links from external data are clickable (no javascript:, data:…). */
export function safeHref(u: string | null | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : undefined;
  } catch {
    return undefined;
  }
}

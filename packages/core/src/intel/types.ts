/** Multi-source crypto intelligence: signals, news and the coin universe. */

export type IntelSource = "coinbase" | "binance" | "coingecko" | "trending" | "derivatives" | "dex" | "news" | "social" | "leverage";
export type Direction = "bullish" | "bearish" | "neutral";

export type IntelKind =
  // Real-time exchange data (Binance all-market, Coinbase radar)
  | "PUMP_EARLY"
  | "DUMP_EARLY"
  | "VOLUME_SURGE"
  | "BREAKOUT_24H_HIGH"
  | "BREAKDOWN_24H_LOW"
  // Aggregator (CoinGecko universe)
  | "TOP_MOVER_1H"
  | "CRASH_1H"
  | "VOLUME_MCAP_ANOMALY"
  | "NEAR_ATH"
  | "TRENDING_ENTRY"
  // Derivatives
  | "FUNDING_EXTREME_LONG"
  | "FUNDING_EXTREME_SHORT"
  | "OPEN_INTEREST_SURGE"
  // DEX (GeckoTerminal via CoinGecko)
  | "DEX_NEW_POOL_TRACTION"
  | "DEX_TRENDING_PUMP"
  | "DEX_RUG_RISK"
  // News
  | "NEWS_BULLISH"
  | "NEWS_BEARISH"
  // New listing on an exchange
  | "NEW_LISTING"
  // Futures liquidation cascades (Binance USDⓈ-M)
  | "LIQUIDATIONS_LONG"
  | "LIQUIDATIONS_SHORT"
  // Attention spike on social networks (Reddit)
  | "SOCIAL_BUZZ"
  // Leveraged markets: long / short setup
  | "LEVERAGE_LONG"
  | "LEVERAGE_SHORT"
  // Several independent sources agree
  | "CONFLUENCE";

export interface IntelSignal {
  id: string;
  ts: number;
  /** Uppercase ticker symbol (e.g. "PEPE"). */
  coin: string;
  coinName: string | null;
  kind: IntelKind;
  direction: Direction;
  source: IntelSource;
  /** 0–100 internal signal strength — NOT a prediction of returns. */
  strength: number;
  title: string;
  reasons: string[];
  /** Raw measured values (for display and later analysis). */
  metrics: Record<string, number | string | null>;
  /** Reference price (USD) at signal time, used to measure the outcome. */
  priceUsd: number | null;
  url: string | null;
  /** Ids of the signals combined in a CONFLUENCE. */
  related?: string[];
}

export interface NewsItem {
  id: string;
  ts: number;
  feed: string;
  title: string;
  link: string;
  summary: string;
  coins: string[];
  direction: Direction;
  /** Matched keywords explaining the direction. */
  tags: string[];
}

/** One row of the coin universe (merged from all sources). */
export interface CoinRow {
  symbol: string;
  name: string;
  coingeckoId: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  rank: number | null;
  volume24hUsd: number | null;
  change1h: number | null;
  change24h: number | null;
  change7d: number | null;
  athChangePct: number | null;
  /** Live exchange data (Binance USDT pair) when available. */
  live: { price: number; change5m: number | null; change15m: number | null; change1h: number | null; volumeRatio1h: number | null; updatedAt: number } | null;
  onCoinbase: boolean;
  onBinance: boolean;
  trendingRank: number | null;
  fundingRatePct: number | null;
  openInterestUsd: number | null;
  lastSignalAt: number | null;
  updatedAt: number;
}

export interface SourceHealth {
  source: IntelSource | "discord";
  enabled: boolean;
  state: "ok" | "degraded" | "down" | "disabled" | "waiting";
  lastSuccessAt: number | null;
  lastError: string | null;
  items: number;
  note: string | null;
}

import { defaultSignalConfig } from "../src/signals/config.js";
import { SignalEngine, type RadarRow } from "../src/signals/engine.js";
import type { ProductMetrics } from "../src/market/state.js";
import { TradingConfigSchema, type TradingConfig } from "../src/trading/config.js";
import { capitalBreakdown, createPortfolio, initializePortfolio, updateMark, type PortfolioState } from "../src/trading/portfolio.js";
import type { RiskContext } from "../src/trading/risk.js";
import type { OrderIntent, Position } from "../src/trading/types.js";
import { product, T0 } from "./helpers.js";

export function tradingConfig(overrides: Record<string, unknown> = {}): TradingConfig {
  return TradingConfigSchema.parse(overrides);
}

export function metrics(productId: string, o: Partial<ProductMetrics> = {}): ProductMetrics {
  const [base = "X", quote = "EUR"] = productId.split("-");
  return {
    productId,
    baseCurrency: base,
    quoteCurrency: quote,
    price: 100,
    bestBid: 99.95,
    bestAsk: 100.05,
    bestBidQty: 100,
    bestAskQty: 100,
    spreadPct: 0.1,
    topBookDepthQuote: 20_000,
    volume24hQuote: 5_000_000,
    pctChange24h: 0,
    changes: { "10s": 1, "30s": 2, "1m": 4, "5m": 5 },
    volumeRecentQuote: 50_000,
    tradesRecent: 100,
    volumeBaselineQuote: 10_000,
    volumeRatio: 5,
    baselineSource: "history",
    segmentReturnsPct: [0.5, 1, 1.5, 2],
    accelerationPct: 1,
    increasingSegments: 3,
    volatilityPct: 0.3,
    historySec: 600,
    lastExchangeTime: T0,
    lastReceivedAt: T0,
    ...o,
  };
}

export function row(m: ProductMetrics, score = 80): RadarRow {
  const r = new SignalEngine(defaultSignalConfig()).evaluate([m], T0, { feedHealthy: true }).rows[0]!;
  return { ...r, scores: { ...r.scores, composite: score } };
}

/** Initialized paper portfolio: 100 cash, 200 € BTC, 200 € ETH. */
export function portfolio(cfg: TradingConfig = tradingConfig()): PortfolioState {
  const p = createPortfolio(cfg.portfolio);
  updateMark(p, "BTC", 100_000, T0);
  updateMark(p, "ETH", 4_000, T0);
  updateMark(p, "SOL", 100, T0);
  initializePortfolio(p, cfg.portfolio, T0);
  return p;
}

export function entry(o: Partial<OrderIntent> = {}): OrderIntent {
  return {
    id: "i1",
    ts: T0,
    kind: "ENTRY",
    productId: "SOL-EUR",
    side: "BUY",
    quoteSize: 10,
    baseSize: null,
    strategyId: "bump-momentum",
    positionId: null,
    referencePrice: 100,
    reason: "test",
    exitReason: null,
    signalScore: 80,
    ...o,
  };
}

export function ctx(o: Partial<RiskContext> & { cfg?: TradingConfig; positions?: Position[] } = {}): RiskContext {
  const cfg = o.cfg ?? tradingConfig();
  const pf = o.portfolio ?? portfolio(cfg);
  const positions = o.positions ?? [];
  return {
    now: T0 + 1000,
    config: cfg,
    portfolio: pf,
    capital: capitalBreakdown(pf, positions, cfg.portfolio),
    openPositions: positions,
    pendingProductIds: new Set(),
    product: product("SOL-EUR", { quoteMinSize: 1, baseMinSize: 0.001 }),
    metrics: metrics("SOL-EUR"),
    feed: { healthy: true, reason: null, state: "open" },
    emergencyStop: { active: false, reason: null },
    trippedBreakers: [],
    history: { realizedPnl24h: 0, realizedPnl7d: 0, entriesLastHour: 0, entriesLastDay: 0, lastLossAt: null, consecutiveErrors: 0 },
    ...o,
  };
}

export function position(o: Partial<Position> = {}): Position {
  return {
    id: "p1",
    strategyId: "bump-momentum",
    productId: "SOL-EUR",
    baseCurrency: "SOL",
    status: "open",
    openedAt: T0,
    entryPrice: 100,
    baseQty: 0.1,
    initialBaseQty: 0.1,
    costQuote: 10,
    entryFees: 0.12,
    entrySlippageQuote: 0,
    entrySignalScore: 80,
    entryReason: "test",
    highestPrice: 100,
    stopLevel: 98,
    trailingLevel: 98,
    takeProfitLevel: null,
    maxDurationSec: null,
    lastPrice: 100,
    lastPriceAt: T0,
    proceedsQuote: 0,
    exitFees: 0,
    exitSlippageQuote: 0,
    exitReason: null,
    exitPrice: null,
    closedAt: null,
    ...o,
  };
}

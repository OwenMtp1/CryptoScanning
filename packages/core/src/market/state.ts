import { SecondSeries } from "./series.js";
import type { MarketEvent, Product, TickerEvent } from "./types.js";
import { WINDOWS, type SignalConfig, type WindowKey } from "../signals/config.js";

export interface ProductMetrics {
  productId: string;
  baseCurrency: string;
  quoteCurrency: string;
  price: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  bestBidQty: number | null;
  bestAskQty: number | null;
  /** (ask − bid) / mid, in %. */
  spreadPct: number | null;
  /** Top-of-book depth (best bid qty × bid + best ask qty × ask), in quote currency. */
  topBookDepthQuote: number | null;
  volume24hQuote: number | null;
  pctChange24h: number | null;
  /** % price change over each window; null while history is insufficient. */
  changes: Record<WindowKey, number | null>;
  volumeRecentQuote: number;
  tradesRecent: number;
  /** Expected quote volume for one recent window, from history or the 24h prior. */
  volumeBaselineQuote: number | null;
  volumeRatio: number | null;
  baselineSource: "history" | "24h" | "none";
  /** Returns (%) of consecutive segments, oldest first. */
  segmentReturnsPct: number[];
  /** Last segment return minus mean of previous segments, in %. */
  accelerationPct: number | null;
  /** Number of consecutive increasing segment returns ending at the latest one. */
  increasingSegments: number;
  /** Std-dev of step returns over the volatility window, in %. */
  volatilityPct: number | null;
  historySec: number;
  lastExchangeTime: number | null;
  lastReceivedAt: number | null;
}

interface ProductState {
  product: Product;
  series: SecondSeries;
  lastTicker: TickerEvent | null;
  lastExchangeTime: number | null;
  lastReceivedAt: number | null;
  /** Exchange time of the first live (non-snapshot) observation. */
  liveSince: number | null;
  seenTradeIds: Set<string>;
  tradeIdQueue: string[];
}

const MAX_TRADE_IDS = 1000;
/** Events stamped further in the future than this (vs local clock) are rejected. */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

export function retentionSecFor(config: SignalConfig): number {
  const v = config.volume;
  const a = config.acceleration;
  return (
    Math.max(
      v.baselineWindowSec + v.recentWindowSec,
      ...WINDOWS.map((w) => w.sec),
      config.volatility.windowSec,
      a.segments * a.segmentSec,
    ) + 60
  );
}

/**
 * In-memory market state built from normalized events. Pure and
 * deterministic: time is always passed in by the caller.
 */
export class MarketStateStore {
  private readonly states = new Map<string, ProductState>();
  private readonly retentionSec: number;
  private _feedClock: number | null = null;
  private _rejectedFutureEvents = 0;

  constructor(private config: SignalConfig) {
    this.retentionSec = retentionSecFor(config);
  }

  /** Latest exchange time observed across the feed (used as "now" for metrics). */
  get feedClock(): number | null {
    return this._feedClock;
  }

  get rejectedFutureEvents(): number {
    return this._rejectedFutureEvents;
  }

  setProducts(products: Product[]) {
    const keep = new Set(products.map((p) => p.productId));
    for (const id of this.states.keys()) if (!keep.has(id)) this.states.delete(id);
    for (const p of products) {
      const existing = this.states.get(p.productId);
      if (existing) existing.product = p;
      else
        this.states.set(p.productId, {
          product: p,
          series: new SecondSeries(this.retentionSec),
          lastTicker: null,
          lastExchangeTime: null,
          lastReceivedAt: null,
          liveSince: null,
          seenTradeIds: new Set(),
          tradeIdQueue: [],
        });
    }
  }

  productIds(): string[] {
    return [...this.states.keys()];
  }

  getProduct(productId: string): Product | undefined {
    return this.states.get(productId)?.product;
  }

  /** Apply one event. Returns false if the event was ignored. */
  apply(event: MarketEvent, receivedAt: number): boolean {
    if (event.kind === "error" || event.kind === "subscriptions") return false;
    if (event.exchangeTime > receivedAt + MAX_FUTURE_SKEW_MS) {
      this._rejectedFutureEvents++;
      return false;
    }
    if (event.kind === "heartbeat") {
      this.advanceClock(event.exchangeTime);
      return true;
    }
    const st = this.states.get(event.productId);
    if (!st) return false;

    if (event.kind === "ticker") {
      st.lastTicker = event;
      st.series.recordPrice(event.exchangeTime, event.price);
      this.advanceClock(event.exchangeTime);
    } else {
      if (st.seenTradeIds.has(event.tradeId)) return false;
      st.seenTradeIds.add(event.tradeId);
      st.tradeIdQueue.push(event.tradeId);
      if (st.tradeIdQueue.length > MAX_TRADE_IDS) st.seenTradeIds.delete(st.tradeIdQueue.shift() as string);
      st.series.recordTrade(event.exchangeTime, event.price, event.size);
      if (!event.snapshot) this.advanceClock(event.exchangeTime);
    }
    const isLive = event.kind === "ticker" || !event.snapshot;
    if (isLive && st.liveSince === null) st.liveSince = event.exchangeTime;
    st.lastExchangeTime = Math.max(st.lastExchangeTime ?? 0, event.exchangeTime);
    st.lastReceivedAt = receivedAt;
    return true;
  }

  private advanceClock(t: number) {
    if (this._feedClock === null || t > this._feedClock) this._feedClock = t;
  }

  metrics(productId: string, now: number): ProductMetrics | null {
    const st = this.states.get(productId);
    if (!st) return null;
    return computeMetrics(st, now, this.config, this.retentionSec);
  }

  allMetrics(now: number): ProductMetrics[] {
    const out: ProductMetrics[] = [];
    for (const st of this.states.values()) out.push(computeMetrics(st, now, this.config, this.retentionSec));
    return out;
  }
}

function pctChange(from: number | null, to: number | null): number | null {
  if (from === null || to === null || from <= 0) return null;
  return ((to - from) / from) * 100;
}

function computeMetrics(st: ProductState, now: number, cfg: SignalConfig, retentionSec: number): ProductMetrics {
  const { product, series, lastTicker: t } = st;
  // History counts from the first live observation only: snapshot trades
  // (sent on subscribe) must not make the baseline look longer than it is.
  const historySec =
    st.liveSince === null ? 0 : Math.max(0, Math.min(retentionSec, Math.floor((now - st.liveSince) / 1000)));
  const price = series.priceAt(now) ?? t?.price ?? product.price;

  const changes = {} as Record<WindowKey, number | null>;
  for (const w of WINDOWS) {
    changes[w.key] = historySec >= w.sec ? pctChange(series.priceAt(now - w.sec * 1000), price) : null;
  }

  // Spread & top-of-book depth.
  const bid = t?.bestBid ?? null;
  const ask = t?.bestAsk ?? null;
  let spreadPct: number | null = null;
  let depth: number | null = null;
  if (bid !== null && ask !== null && bid > 0 && ask >= bid) {
    spreadPct = ((ask - bid) / ((ask + bid) / 2)) * 100;
    if (t?.bestBidQty != null && t?.bestAskQty != null) depth = t.bestBidQty * bid + t.bestAskQty * ask;
  }

  const volume24hQuote =
    t?.volume24hBase != null && price !== null ? t.volume24hBase * price : product.volume24hQuote;

  // Volume ratio vs baseline.
  const v = cfg.volume;
  const recentFrom = now - v.recentWindowSec * 1000;
  const recent = series.volumeBetween(recentFrom, now);
  let volumeBaselineQuote: number | null = null;
  let baselineSource: ProductMetrics["baselineSource"] = "none";
  const baselineSpanSec = Math.min(v.baselineWindowSec, historySec - v.recentWindowSec);
  if (baselineSpanSec >= v.minBaselineHistorySec) {
    const base = series.volumeBetween(recentFrom - baselineSpanSec * 1000, recentFrom);
    volumeBaselineQuote = (base.quote / baselineSpanSec) * v.recentWindowSec;
    baselineSource = "history";
  } else if (volume24hQuote !== null && volume24hQuote > 0) {
    volumeBaselineQuote = (volume24hQuote / 86_400) * v.recentWindowSec;
    baselineSource = "24h";
  }
  const volumeRatio =
    volumeBaselineQuote !== null && volumeBaselineQuote > 0 ? recent.quote / volumeBaselineQuote : null;

  // Acceleration: returns over consecutive segments.
  const a = cfg.acceleration;
  const segmentReturnsPct: number[] = [];
  if (historySec >= a.segments * a.segmentSec) {
    for (let k = a.segments; k >= 1; k--) {
      const r = pctChange(
        series.priceAt(now - k * a.segmentSec * 1000),
        series.priceAt(now - (k - 1) * a.segmentSec * 1000),
      );
      if (r === null) break;
      segmentReturnsPct.push(r);
    }
  }
  let accelerationPct: number | null = null;
  let increasingSegments = 0;
  if (segmentReturnsPct.length === a.segments) {
    const last = segmentReturnsPct[segmentReturnsPct.length - 1] as number;
    const prev = segmentReturnsPct.slice(0, -1);
    accelerationPct = last - prev.reduce((s, x) => s + x, 0) / prev.length;
    for (let i = segmentReturnsPct.length - 1; i > 0; i--) {
      if ((segmentReturnsPct[i] as number) > (segmentReturnsPct[i - 1] as number)) increasingSegments++;
      else break;
    }
  }

  // Volatility: std-dev of step returns.
  const vol = cfg.volatility;
  let volatilityPct: number | null = null;
  if (historySec >= vol.windowSec) {
    const rets: number[] = [];
    for (let s = vol.windowSec; s >= vol.stepSec; s -= vol.stepSec) {
      const r = pctChange(series.priceAt(now - s * 1000), series.priceAt(now - (s - vol.stepSec) * 1000));
      if (r !== null) rets.push(r);
    }
    if (rets.length >= 2) {
      const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
      volatilityPct = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1));
    }
  }

  return {
    productId: product.productId,
    baseCurrency: product.baseCurrency,
    quoteCurrency: product.quoteCurrency,
    price,
    bestBid: bid,
    bestAsk: ask,
    bestBidQty: t?.bestBidQty ?? null,
    bestAskQty: t?.bestAskQty ?? null,
    spreadPct,
    topBookDepthQuote: depth,
    volume24hQuote,
    pctChange24h: t?.pctChange24h ?? product.pctChange24h,
    changes,
    volumeRecentQuote: recent.quote,
    tradesRecent: recent.trades,
    volumeBaselineQuote,
    volumeRatio,
    baselineSource,
    segmentReturnsPct,
    accelerationPct,
    increasingSegments,
    volatilityPct,
    historySec,
    lastExchangeTime: st.lastExchangeTime,
    lastReceivedAt: st.lastReceivedAt,
  };
}

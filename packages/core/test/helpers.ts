import { MarketStateStore } from "../src/market/state.js";
import { defaultSignalConfig, type SignalConfig } from "../src/signals/config.js";
import type { Product, TickerEvent } from "../src/market/types.js";

export const T0 = Date.parse("2026-09-25T10:00:00.000Z");

export function product(id: string, overrides: Partial<Product> = {}): Product {
  const [base = "X", quote = "EUR"] = id.split("-");
  return {
    productId: id,
    baseCurrency: base,
    quoteCurrency: quote,
    baseName: base,
    displayName: id,
    productType: "SPOT",
    status: "online",
    price: 100,
    pctChange24h: 0,
    volume24hBase: 86_400,
    volume24hQuote: 8_640_000,
    baseMinSize: null,
    quoteMinSize: null,
    baseIncrement: null,
    quoteIncrement: null,
    priceIncrement: null,
    flags: {
      tradingDisabled: false,
      isDisabled: false,
      cancelOnly: false,
      limitOnly: false,
      postOnly: false,
      viewOnly: false,
      auctionMode: false,
      isNew: false,
    },
    alias: null,
    aliasTo: [],
    tradabilityVerified: false,
    ...overrides,
  };
}

export function ticker(productId: string, t: number, price: number, opts: Partial<TickerEvent> = {}): TickerEvent {
  return {
    kind: "ticker",
    productId,
    exchangeTime: t,
    price,
    bestBid: price * 0.9995,
    bestAsk: price * 1.0005,
    bestBidQty: 500,
    bestAskQty: 500,
    volume24hBase: 86_400,
    pctChange24h: 0,
    high24h: null,
    low24h: null,
    ...opts,
  };
}

/**
 * Feed a store with one ticker + one trade per second following `priceAt(s)`
 * and `volumeAt(s)` (base units per second) for `seconds` seconds from T0.
 */
export function feed(
  store: MarketStateStore,
  productId: string,
  seconds: number,
  priceAt: (s: number) => number,
  volumeAt: (s: number) => number = () => 1,
  tickerOpts: (s: number) => Partial<TickerEvent> = () => ({}),
  start = T0,
) {
  for (let s = 0; s <= seconds; s++) {
    const t = start + s * 1000;
    const p = priceAt(s);
    store.apply(ticker(productId, t, p, tickerOpts(s)), t);
    store.apply(
      { kind: "trade", productId, tradeId: `${productId}-${start}-${s}`, exchangeTime: t, price: p, size: volumeAt(s), side: "BUY", snapshot: false },
      t,
    );
  }
  return start + seconds * 1000;
}

export function makeStore(ids: string[], cfg: SignalConfig = defaultSignalConfig(), overrides: Record<string, Partial<Product>> = {}) {
  const store = new MarketStateStore(cfg);
  store.setProducts(ids.map((id) => product(id, overrides[id])));
  return store;
}

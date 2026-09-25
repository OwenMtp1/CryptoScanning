import { describe, expect, it } from "vitest";
import { defaultSignalConfig } from "../src/signals/config.js";
import { SecondSeries } from "../src/market/series.js";
import { T0, feed, makeStore, ticker } from "./helpers.js";

describe("SecondSeries", () => {
  it("carries prices forward and drops data beyond retention", () => {
    const s = new SecondSeries(10);
    s.recordPrice(T0, 100);
    s.recordPrice(T0 + 5000, 105);
    expect(s.priceAt(T0 + 3000)).toBe(100);
    expect(s.priceAt(T0 + 7000)).toBe(105);
    expect(s.priceAt(T0 - 1000)).toBeNull();
    s.recordPrice(T0 + 30_000, 110);
    s.recordPrice(T0 + 1000, 1); // too old, ignored
    expect(s.priceAt(T0 + 30_000)).toBe(110);
    expect(s.priceAt(T0 + 5000)).toBeNull(); // evicted
  });

  it("sums volume over a half-open range", () => {
    const s = new SecondSeries(100);
    s.recordTrade(T0, 10, 1);
    s.recordTrade(T0 + 1000, 10, 2);
    s.recordTrade(T0 + 2000, 10, 3);
    expect(s.volumeBetween(T0, T0 + 2000)).toEqual({ quote: 30, base: 3, trades: 2 });
  });
});

describe("MarketStateStore metrics", () => {
  it("computes window changes only once enough history exists", () => {
    const store = makeStore(["SOL-EUR"]);
    const now = feed(store, "SOL-EUR", 40, (s) => 100 + s * 0.1);
    const m = store.metrics("SOL-EUR", now)!;
    expect(m.changes["10s"]).toBeCloseTo(((104 - 103) / 103) * 100, 6);
    expect(m.changes["30s"]).toBeCloseTo(((104 - 101) / 101) * 100, 6);
    expect(m.changes["1m"]).toBeNull();
    expect(m.changes["5m"]).toBeNull();
  });

  it("computes spread and top-of-book depth from the ticker", () => {
    const store = makeStore(["BTC-EUR"]);
    store.apply(ticker("BTC-EUR", T0, 100, { bestBid: 99, bestAsk: 101, bestBidQty: 2, bestAskQty: 3 }), T0);
    const m = store.metrics("BTC-EUR", T0)!;
    expect(m.spreadPct).toBeCloseTo(2, 6);
    expect(m.topBookDepthQuote).toBeCloseTo(99 * 2 + 101 * 3, 6);
  });

  it("uses the 24h prior before local history is long enough, then local history", () => {
    const cfg = defaultSignalConfig();
    const store = makeStore(["ETH-EUR"], cfg);
    // ticker volume_24_h = 86400 base @ ~100 → 100 quote/s → 6000 per 60s window
    let now = feed(store, "ETH-EUR", 120, () => 100, () => 1);
    let m = store.metrics("ETH-EUR", now)!;
    expect(m.baselineSource).toBe("24h");
    expect(m.volumeBaselineQuote).toBeCloseTo(6000, 0);
    expect(m.volumeRatio).toBeCloseTo(6000 / 6000, 1);

    now = feed(store, "ETH-EUR", 600, () => 100, () => 1, () => ({}), now + 1000);
    m = store.metrics("ETH-EUR", now)!;
    expect(m.baselineSource).toBe("history");
    expect(m.volumeBaselineQuote).toBeCloseTo(6000, -2);
    expect(m.volumeRatio).toBeCloseTo(1, 1);
  });

  it("does not count subscription-snapshot trades as live history", () => {
    const store = makeStore(["ETH-EUR"]);
    for (let i = 0; i < 50; i++)
      store.apply(
        { kind: "trade", productId: "ETH-EUR", tradeId: `s${i}`, exchangeTime: T0 - 20 * 60_000 + i * 1000, price: 100, size: 1, side: "BUY", snapshot: true },
        T0,
      );
    store.apply(ticker("ETH-EUR", T0, 100), T0);
    expect(store.metrics("ETH-EUR", T0)!.historySec).toBe(0);
  });

  it("deduplicates trades by trade id (reconnect replays)", () => {
    const store = makeStore(["ETH-EUR"]);
    const trade = { kind: "trade" as const, productId: "ETH-EUR", tradeId: "t1", exchangeTime: T0, price: 100, size: 1, side: "BUY", snapshot: false };
    expect(store.apply(trade, T0)).toBe(true);
    expect(store.apply(trade, T0)).toBe(false);
  });

  it("rejects events stamped far in the future", () => {
    const store = makeStore(["ETH-EUR"]);
    expect(store.apply(ticker("ETH-EUR", T0 + 3_600_000, 100), T0)).toBe(false);
    expect(store.rejectedFutureEvents).toBe(1);
    expect(store.feedClock).toBeNull();
  });

  it("measures acceleration on consecutive segments", () => {
    const store = makeStore(["SOL-EUR"]);
    // Segment returns ≈ +0.5, +1.2, +2.4, +4 % (the example from the spec).
    const levels = [100, 100.5, 100.5 * 1.012, 100.5 * 1.012 * 1.024, 100.5 * 1.012 * 1.024 * 1.04];
    const now = feed(store, "SOL-EUR", 60, (s) => levels[Math.floor(s / 15)]!);
    const m = store.metrics("SOL-EUR", now)!;
    expect(m.segmentReturnsPct.map((r) => Number(r.toFixed(1)))).toEqual([0.5, 1.2, 2.4, 4]);
    expect(m.increasingSegments).toBe(3);
    expect(m.accelerationPct).toBeCloseTo(4 - (0.5 + 1.2 + 2.4) / 3, 1);
  });
});

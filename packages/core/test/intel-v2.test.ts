import { describe, expect, it } from "vitest";
import { defaultIntelConfig } from "../src/intel/config.js";
import { detectLive, isNoiseCoin, type LiveSnapshot } from "../src/intel/detectors.js";
import { IntelEngine } from "../src/intel/engine.js";
import { parsePerps, readLeverage, type LeverageContext } from "../src/intel/leverage.js";
import { SocialBuzz } from "../src/intel/social.js";
import { BinanceRestHistory } from "../src/intel/binance-rest.js";
import { OutcomeTracker } from "../src/intel/tracker.js";
import type { IntelSignal } from "../src/intel/types.js";

const cfg = defaultIntelConfig();
const T0 = Date.UTC(2026, 8, 20, 12, 0);
const live = (o: Partial<LiveSnapshot> = {}): LiveSnapshot => ({ coin: "PEPE", pair: "PEPEUSDT", priceUsd: 1, change5m: 0, change15m: 0, change1h: 0, volumeRatio1h: 1, volume24hUsd: 5e7, high24h: 1.2, low24h: 0.8, ...o });

describe("per-coin thresholds and refinements", () => {
  it("a calm coin (BTC-like) alerts on a smaller move, a wild one needs a bigger move", () => {
    expect(detectLive(live({ change5m: 2.5, vol5m: 0.15 }), cfg.binance)).toHaveLength(1); // floor = 2 %
    expect(detectLive(live({ change5m: 2.5 }), cfg.binance)).toHaveLength(0); // fixed 4 %
    expect(detectLive(live({ change5m: 5, vol5m: 2 }), cfg.binance)).toHaveLength(0); // needs 8 %
    const r = detectLive(live({ change5m: 9, vol5m: 2 }), cfg.binance)[0]!;
    expect(r.reasons.join(" ")).toContain("volatilité");
  });
  it("confirmation, fading momentum and buy/sell flow move the strength", () => {
    const base = detectLive(live({ change5m: 6, change1h: 0 }), cfg.binance)[0]!.strength;
    expect(detectLive(live({ change5m: 6, change1h: 5 }), cfg.binance)[0]!.strength).toBeGreaterThan(base);
    expect(detectLive(live({ change5m: 6, change1h: -5 }), cfg.binance)[0]!.strength).toBeLessThan(base);
    const buyers = detectLive(live({ change5m: 6, takerBuyRatio: 0.7 }), cfg.binance)[0]!;
    const sellers = detectLive(live({ change5m: 6, takerBuyRatio: 0.35 }), cfg.binance)[0]!;
    expect(buyers.strength).toBeGreaterThan(sellers.strength);
    expect(sellers.reasons.join(" ")).toContain("fragile");
    const fading = detectLive(live({ change5m: 0.5, change15m: 12 }), cfg.binance)[0]!;
    expect(fading.reasons.join(" ")).toContain("l'élan ralentit");
  });
  it("stablecoins and wrapped tokens are noise", () => {
    expect(isNoiseCoin("usdc")).toBe(true);
    expect(isNoiseCoin("WBTC")).toBe(true);
    expect(isNoiseCoin("PEPE")).toBe(false);
  });
});

describe("outcomes relative to the market (Bitcoin)", () => {
  it("a +3 % move while Bitcoin does +5 % is an excess return of −2 %", () => {
    const t = new OutcomeTracker(cfg.tracking);
    const sig: IntelSignal = { id: "a", ts: T0, coin: "SOL", coinName: null, kind: "PUMP_EARLY", direction: "bullish", source: "binance", strength: 70, title: "t", reasons: [], metrics: {}, priceUsd: 100, url: null };
    t.track(sig, 50_000);
    t.track(sig, 50_000); // same id: tracked once
    const prices: Record<string, number> = { SOL: 103, BTC: 52_500 };
    t.tick(T0 + 15 * 60_000, (c) => prices[c] ?? null);
    const it = t.list()[0]!;
    expect(it.returns["15"]).toBeCloseTo(3, 6);
    expect(it.excess!["15"]).toBeCloseTo(-2, 6);
    const h = t.stats()[0]!.horizons["15"]!;
    expect(h.hitRatePct).toBe(100);
    expect(h.excessHitRatePct).toBe(0);
    expect(t.list()).toHaveLength(1);
  });
});

describe("Reddit buzz", () => {
  it("alerts when mentions jump versus the coin's own baseline", () => {
    const b = new SocialBuzz(cfg.social);
    const post = (i: number, ts: number) => ({ id: `p${i}`, ts, coins: ["PEPE"], direction: "bullish" as const, title: "pepe", link: "l", feed: "r/x" });
    expect(b.add([post(0, T0 - 5 * 3_600_000)], T0 - 5 * 3_600_000)).toEqual([]);
    const burst = Array.from({ length: 6 }, (_, i) => post(i + 1, T0 - i * 60_000));
    const c = b.add(burst, T0);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: "SOCIAL_BUZZ", source: "social", direction: "bullish" });
    expect(b.add(burst, T0)).toEqual([]); // already seen
    const b2 = new SocialBuzz(cfg.social, JSON.parse(JSON.stringify(b.export())));
    expect(b2.add(burst, T0)).toEqual([]);
  });
});

describe("leveraged markets", () => {
  it("parses Coinbase perpetuals (official fields) and ignores spot products", () => {
    const m = parsePerps({
      products: [
        { product_id: "BTC-PERP-INTX", price: "100000", price_percentage_change_24h: "2", approximate_quote_24h_volume: "5e9", status: "online", future_product_details: { venue: "INTX", contract_root_unit: "BTC", contract_expiry_type: "PERPETUAL", contract_display_name: "BTC PERP", perpetual_details: { open_interest: "1000", funding_rate: "0.0001", max_leverage: "20" } } },
        { product_id: "ETH-USD", price: "3000", status: "online" },
      ],
    });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ coin: "BTC", maxLeverage: 20, venue: "INTX", name: "BTC PERP" });
    expect(m[0]!.fundingPct).toBeCloseTo(0.01, 8);
  });
  it("scores LONG / SHORT with every factor explained, and the liquidation distance", () => {
    const [m] = parsePerps({ products: [{ product_id: "SOL-PERP-INTX", price: "150", status: "online", future_product_details: { contract_root_unit: "SOL", contract_expiry_type: "PERPETUAL", perpetual_details: { max_leverage: "10" } } }] });
    const ctx = (o: Partial<LeverageContext>): LeverageContext => ({ change15m: null, change1h: null, takerBuyRatio: null, binanceFundingPct: null, longShortRatio: null, oiChangePct: null, recent: [], btcChange1h: null, ...o });
    const up = readLeverage(m!, ctx({ change15m: 2, change1h: 4, takerBuyRatio: 0.68, recent: [{ direction: "bullish", strength: 80, kind: "PUMP_EARLY" }] }));
    expect(up.bias).toBe("LONG");
    expect(up.liquidationMovePct).toBe(10);
    expect(up.reasons.length).toBeGreaterThanOrEqual(3);
    const down = readLeverage(m!, ctx({ change1h: -4, binanceFundingPct: 0.08, longShortRatio: 3 }));
    expect(down.bias).toBe("SHORT");
    expect(down.anomalies.join(" ")).toContain("funding");
    expect(readLeverage(m!, ctx({})).bias).toBe("NEUTRE");
  });
});

describe("misc", () => {
  it("external signals are shown but do not trigger cooldowns", () => {
    const e = new IntelEngine(cfg);
    const s: IntelSignal = { id: "bot-1", ts: T0, coin: "SOL", coinName: null, kind: "PUMP_EARLY", direction: "bullish", source: "binance", strength: 70, title: "t", reasons: [], metrics: {}, priceUsd: 1, url: null };
    expect(e.addExternal([s, s])).toBe(1);
    expect(e.recentSignals()).toHaveLength(1);
    expect(e.ingest([{ ...s, coinName: null }], T0)).toHaveLength(1);
  });
  it("Binance REST preview does not record history", () => {
    const h = new BinanceRestHistory(["USDT"]);
    const t = [{ symbol: "PEPEUSDT", openPrice: 1, highPrice: 1, lowPrice: 1, lastPrice: 1, quoteVolume: 1e7, closeTime: T0 }];
    h.preview(t, T0);
    expect(h.export()).toEqual({});
    h.update(t, T0);
    expect(Object.keys(h.export())).toEqual(["PEPE"]);
  });
});

import { mergePerps, parseBinanceFutures, parseIntxInstruments } from "../src/intel/leverage.js";

describe("other perpetual sources", () => {
  it("Coinbase International instruments: PERP only, max leverage = 1 / base_imf, funding in %", () => {
    const m = parseIntxInstruments([
      { symbol: "BTC-PERP", type: "PERP", base_asset_name: "BTC", base_imf: 0.02, open_interest: "10", notional_24hr: "5000000", trading_state: "TRADING", quote: { mark_price: "100000", predicted_funding: "0.00001" } },
      { symbol: "BTC-USDC", type: "SPOT", base_asset_name: "BTC" },
      { symbol: "OLD-PERP", type: "PERP", base_asset_name: "OLD", trading_state: "DELISTED" },
    ]);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ coin: "BTC", maxLeverage: 50, venue: "Coinbase International", openInterest: 1_000_000, volume24hUsd: 5_000_000 });
    expect(m[0]!.fundingPct).toBeCloseTo(0.001, 8);
  });
  it("Binance Futures public data (no max leverage) and merging (Coinbase first)", () => {
    const b = parseBinanceFutures([{ symbol: "ETHUSDT", markPrice: "3000", lastFundingRate: "0.0001" }, { symbol: "ETHBUSD", markPrice: "1" }], [{ symbol: "ETHUSDT", priceChangePercent: "2.5", quoteVolume: "900" }]);
    expect(b).toEqual([expect.objectContaining({ coin: "ETH", maxLeverage: null, change24h: 2.5, volume24hUsd: 900 })]);
    expect(b[0]!.fundingPct).toBeCloseTo(0.01, 8);
    const merged = mergePerps([{ ...b[0]!, venue: "Coinbase" }], b);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.venue).toBe("Coinbase");
  });
});

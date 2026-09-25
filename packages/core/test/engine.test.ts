import { describe, expect, it } from "vitest";
import { SignalConfigSchema, defaultSignalConfig } from "../src/signals/config.js";
import { SignalEngine } from "../src/signals/engine.js";
import { scoreMetrics } from "../src/signals/scoring.js";
import { T0, feed, makeStore } from "./helpers.js";

let n = 0;
const ids = { idFactory: (p: string) => `${p}${++n}` };

/** 6 min flat at 100 with 1 base/s, then a 60 s accelerating pump with 6× volume. */
function pumpScenario(productId: string, tickerOpts = () => ({})) {
  const store = makeStore([productId]);
  let now = feed(store, productId, 360, () => 100, () => 1, tickerOpts);
  now = feed(
    store,
    productId,
    60,
    (s) => 100 * (1 + 0.06 * (s / 60) ** 2),
    () => 6,
    tickerOpts,
    now + 1000,
  );
  return { store, now };
}

describe("SignalEngine", () => {
  it("emits nothing on a flat market", () => {
    const store = makeStore(["BTC-EUR"]);
    const now = feed(store, "BTC-EUR", 400, () => 100);
    const engine = new SignalEngine(defaultSignalConfig(), ids);
    const r = engine.evaluate(store.allMetrics(now), now, { feedHealthy: true });
    expect(r.newSignals).toEqual([]);
    expect(r.opened).toEqual([]);
    expect(r.rows[0]!.level).toBe("none");
  });

  it("detects a pump: surge + volume + acceleration → tradable opportunity", () => {
    const { store, now } = pumpScenario("SOL-EUR");
    const engine = new SignalEngine(defaultSignalConfig(), ids);
    const r = engine.evaluate(store.allMetrics(now), now, { feedHealthy: true });
    const types = new Set(r.newSignals.map((s) => s.type));
    expect(types.has("PRICE_SURGE")).toBe(true);
    expect(types.has("VOLUME_SPIKE")).toBe(true);
    expect(types.has("ACCELERATION")).toBe(true);
    expect(types.has("LIQUIDITY_WARNING")).toBe(false);
    expect(r.opened).toHaveLength(1);
    const opp = r.opened[0]!;
    expect(opp.productId).toBe("SOL-EUR");
    expect(opp.tradable).toBe(true);
    expect(opp.score).toBeGreaterThanOrEqual(65);
    expect(opp.suggestedAction).toMatch(/RADAR/);
    expect(opp.reasons.join(" ")).toMatch(/sur 1m/);
    expect(r.rows[0]!.level).toBe("opportunity");
  });

  it("flags an illiquid pump as NOT tradable", () => {
    const { store, now } = pumpScenario("MICRO-EUR", () => ({ bestBid: 98, bestAsk: 102, bestBidQty: 1, bestAskQty: 1 }));
    const engine = new SignalEngine(defaultSignalConfig(), ids);
    const r = engine.evaluate(store.allMetrics(now), now, { feedHealthy: true });
    expect(r.newSignals.some((s) => s.type === "LIQUIDITY_WARNING")).toBe(true);
    expect(r.rows[0]!.liquidity.tradable).toBe(false);
    for (const o of r.opened) {
      expect(o.tradable).toBe(false);
      expect(o.liquidityIssues.length).toBeGreaterThan(0);
    }
  });

  it("produces no signal when the feed is stale", () => {
    const { store, now } = pumpScenario("SOL-EUR");
    const engine = new SignalEngine(defaultSignalConfig(), ids);
    const r = engine.evaluate(store.allMetrics(now), now, { feedHealthy: false });
    expect(r.newSignals).toEqual([]);
    expect(r.opened).toEqual([]);
  });

  it("respects the per-signal cooldown", () => {
    const { store, now } = pumpScenario("SOL-EUR");
    const engine = new SignalEngine(defaultSignalConfig(), ids);
    const first = engine.evaluate(store.allMetrics(now), now, { feedHealthy: true }).newSignals.length;
    expect(first).toBeGreaterThan(0);
    expect(engine.evaluate(store.allMetrics(now), now + 1000, { feedHealthy: true }).newSignals).toEqual([]);
    expect(engine.evaluate(store.allMetrics(now), now + 61_000, { feedHealthy: true }).newSignals.length).toBeGreaterThan(0);
  });

  it("detects a drop without opening an opportunity", () => {
    const store = makeStore(["ETH-EUR"]);
    let now = feed(store, "ETH-EUR", 360, () => 100);
    now = feed(store, "ETH-EUR", 60, (s) => 100 * (1 - 0.05 * (s / 60)), () => 1, () => ({}), now + 1000);
    const engine = new SignalEngine(defaultSignalConfig(), ids);
    const r = engine.evaluate(store.allMetrics(now), now, { feedHealthy: true });
    expect(r.newSignals.some((s) => s.type === "PRICE_DROP")).toBe(true);
    expect(r.newSignals.some((s) => s.type === "PRICE_SURGE")).toBe(false);
    expect(r.opened).toEqual([]);
  });

  it("expires an opportunity after the score stays low", () => {
    const { store, now } = pumpScenario("SOL-EUR");
    const engine = new SignalEngine(defaultSignalConfig(), ids);
    expect(engine.evaluate(store.allMetrics(now), now, { feedHealthy: true }).opened).toHaveLength(1);
    // Market goes flat for 10 minutes at the new level.
    const later = feed(store, "SOL-EUR", 600, () => 106, () => 1, () => ({}), now + 1000);
    let expired = 0;
    for (let t = later - 60_000; t <= later; t += 1000) expired += engine.evaluate(store.allMetrics(t), t, { feedHealthy: true }).expired.length;
    expect(expired).toBe(1);
    expect(engine.activeOpportunities()).toEqual([]);
  });

  it("keeps every score within 0..100", () => {
    const { store, now } = pumpScenario("SOL-EUR");
    for (const m of store.allMetrics(now)) {
      const s = scoreMetrics(m, defaultSignalConfig());
      for (const v of Object.values(s)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("honours configurable weights", () => {
    const { store, now } = pumpScenario("SOL-EUR");
    const m = store.metrics("SOL-EUR", now)!;
    const onlyLiquidity = SignalConfigSchema.parse({
      scoring: {
        weights: { momentum: 0, volume: 0, acceleration: 0, liquidity: 1, volatility: 0 },
        refs: defaultSignalConfig().scoring.refs,
      },
    });
    const s = scoreMetrics(m, onlyLiquidity);
    expect(s.composite).toBe(s.liquidity);
  });

  it("rejects all-zero weights", () => {
    expect(() =>
      SignalConfigSchema.parse({
        scoring: { weights: { momentum: 0, volume: 0, acceleration: 0, liquidity: 0, volatility: 0 }, refs: defaultSignalConfig().scoring.refs },
      }),
    ).toThrow();
  });
});

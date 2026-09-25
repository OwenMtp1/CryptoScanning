import { describe, expect, it } from "vitest";
import { decodeCoinbaseFrame } from "../src/coinbase/decoder.js";
import { filterRadarProducts, parseProductsPage } from "../src/coinbase/products.js";
import { MarketStateStore } from "../src/market/state.js";
import { defaultSignalConfig } from "../src/signals/config.js";
import { SignalEngine, type Opportunity, type Signal } from "../src/signals/engine.js";
import { MarketSimulator } from "../src/simulation/simulator.js";
import { T0 } from "./helpers.js";

function run(seed: number, seconds: number, script: (sim: MarketSimulator, t: number) => void) {
  const sim = new MarketSimulator({ seed, autoScenarios: false });
  const cfg = defaultSignalConfig();
  const store = new MarketStateStore(cfg);
  const products = filterRadarProducts(parseProductsPage(sim.productsResponse()).products, { quoteCurrencies: [], maxProducts: 0 }).selected;
  store.setProducts(products);
  const engine = new SignalEngine(cfg);
  const signals: Signal[] = [];
  const opened: Opportunity[] = [];
  let issues = 0;
  for (let t = T0; t <= T0 + seconds * 1000; t += 250) {
    script(sim, t);
    for (const f of sim.step(t).frames) {
      const d = decodeCoinbaseFrame(f);
      issues += d.issues.length;
      for (const e of d.events) store.apply(e, t);
    }
    if ((t - T0) % 1000 === 0) {
      const r = engine.evaluate(store.allMetrics(t), t, { feedHealthy: true });
      signals.push(...r.newSignals);
      opened.push(...r.opened);
    }
  }
  return { sim, signals, opened, issues };
}

describe("MarketSimulator", () => {
  it("is deterministic for a given seed", () => {
    const a = new MarketSimulator({ seed: 7 });
    const b = new MarketSimulator({ seed: 7 });
    for (let t = T0; t < T0 + 20_000; t += 500) expect(a.step(t).frames).toEqual(b.step(t).frames);
  });

  it("produces frames that decode without issues", () => {
    const { issues } = run(3, 30, () => {});
    expect(issues).toBe(0);
  });

  it("end-to-end: an injected pump on SOL-EUR is detected as a tradable opportunity", () => {
    const start = T0 + 420_000;
    const { opened, signals } = run(11, 560, (sim, t) => {
      if (t === start) sim.startScenario("pump", t, "SOL-EUR");
    });
    const sol = opened.filter((o) => o.productId === "SOL-EUR");
    expect(sol.length).toBeGreaterThanOrEqual(1);
    expect(sol[0]!.tradable).toBe(true);
    expect(sol[0]!.detectedAt).toBeGreaterThanOrEqual(start);
    expect(signals.some((s) => s.productId === "SOL-EUR" && s.type === "PRICE_SURGE")).toBe(true);
  });

  it("end-to-end: an illiquid pump is never presented as tradable", () => {
    const start = T0 + 420_000;
    const { opened, signals } = run(5, 520, (sim, t) => {
      if (t === start) sim.startScenario("illiquid_pump", t, "MICRO-EUR");
    });
    expect(signals.some((s) => s.productId === "MICRO-EUR" && s.type === "LIQUIDITY_WARNING")).toBe(true);
    expect(opened.filter((o) => o.productId === "MICRO-EUR").every((o) => !o.tradable)).toBe(true);
  });
});

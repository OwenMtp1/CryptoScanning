import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_STRATEGY,
  MarketSimulator,
  TradingConfigSchema,
  defaultSignalConfig,
  parseProductsPage,
  type LogEvent,
  type TradingConfig,
} from "@radar/core";
import { parseMode } from "../src/config/mode.js";
import type { EmitInput } from "../src/logging/event-log.js";
import { MarketDataEngine } from "../src/market-data/market-data-engine.js";
import type { MarketDataSource, SourceStatus } from "../src/market-data/source.js";
import { RadarService } from "../src/signal-engine/radar-service.js";
import { PaperStore } from "../src/trading/paper-store.js";
import { StrategyStore } from "../src/trading/strategy-store.js";
import { TradingService, type TradingMode } from "../src/trading/trading-service.js";

const T0 = Date.parse("2026-09-25T10:00:00Z");

/** Tighter exits so a full open → close cycle fits in a short simulation. */
function testConfig(overrides: { rotation?: boolean } = {}): TradingConfig {
  return TradingConfigSchema.parse({
    paper: { unfilledProbability: 0 },
    strategies: [
      {
        ...DEFAULT_STRATEGY,
        exit: { stopLossPct: 2, trailingStopPct: 1, takeProfitPct: null, maxDurationSec: 300 },
        afterExit: { rotation: { enabled: overrides.rotation ?? true, mode: "proceeds", allocations: { BTC: 50, ETH: 50 }, minOrderQuote: 1 } },
      },
    ],
  });
}

async function harness(mode: TradingMode, config: TradingConfig = testConfig(), storeDir: string | null = null, strategyDir: string | null = null) {
  let now = T0;
  const events: LogEvent[] = [];
  const log = (e: EmitInput) => void events.push({ id: String(events.length), ts: new Date(now).toISOString(), ...e });
  const sim = new MarketSimulator({ seed: 11, autoScenarios: false });
  const source: MarketDataSource = {
    kind: "simulated",
    loadProducts: async () => {
      const p = parseProductsPage(sim.productsResponse());
      return { products: p.products, invalid: p.invalid };
    },
    start: () => {},
    stop: () => {},
    status: (): SourceStatus => ({ source: "simulated", state: "open", connections: 1, openConnections: 1, subscribedProducts: 0, lastMessageAt: now, reconnects: 0 }),
  };
  const sigCfg = defaultSignalConfig();
  const market = new MarketDataEngine({
    source,
    config: sigCfg,
    log,
    quoteCurrencies: ["EUR"],
    maxProducts: 0,
    requiredProducts: TradingService.requiredProducts(config),
    now: () => now,
  });
  await market.loadProducts();
  const radar = new RadarService(market, sigCfg, log, 1000, mode);
  const queue: { at: number; fn: () => void }[] = [];
  const trading = new TradingService({
    mode,
    config,
    market,
    log,
    store: storeDir ? new PaperStore(storeDir) : null,
    strategyStore: strategyDir ? new StrategyStore(strategyDir) : null,
    now: () => now,
    schedule: (fn, ms) => void queue.push({ at: now + ms, fn }),
  });
  radar.subscribe((s) => trading.onSnapshot(s));
  const invariants: string[] = [];

  function run(seconds: number, each?: (t: number) => void) {
    const end = now + seconds * 1000;
    while (now < end) {
      now += 250;
      each?.(now);
      for (const f of sim.step(now).frames) market.onFrame(f, now, "sim");
      for (const q of queue.filter((x) => x.at <= now)) {
        queue.splice(queue.indexOf(q), 1);
        q.fn();
      }
      if ((now - T0) % 1000 === 0) {
        radar.tick();
        const v = trading.view();
        if (v.initialized) {
          // The bot must never dip into protected capital nor go below zero cash.
          if (v.capital.cash < -1e-9) invariants.push(`cash négatif ${v.capital.cash}`);
          if (v.capital.engaged > v.capital.tradable + 0.5) invariants.push(`engagé ${v.capital.engaged} > tradable ${v.capital.tradable}`);
          if (v.positions.length > config.risk.maxOpenPositions) invariants.push("trop de positions");
        }
      }
    }
  }
  const pump = (productId: string, magnitudePct = 8, durationSec = 90) => {
    const sc = sim.startScenario("pump", now, productId)!;
    sc.magnitudePct = magnitudePct;
    sc.durationMs = durationSec * 1000;
    return sc;
  };
  const types = () => events.map((e) => e.type);
  return { trading, events, types, run, pump, invariants, get now() { return now; } };
}

describe("parseMode", () => {
  it("accepts RADAR and PAPER, refuses LIVE and anything else", () => {
    expect(parseMode("paper")).toEqual({ ok: true, mode: "PAPER" });
    expect(parseMode("RADAR")).toEqual({ ok: true, mode: "RADAR" });
    expect(parseMode("LIVE").ok).toBe(false);
    expect(parseMode("").ok).toBe(false);
  });
});

describe("TradingService (PAPER, end-to-end on simulated market)", () => {
  it("initializes the paper portfolio from the first BTC/ETH prices", async () => {
    const h = await harness("PAPER");
    h.run(3);
    const v = h.trading.view();
    expect(v.initialized).toBe(true);
    expect(v.initialValue).toBeCloseTo(500, 6);
    expect(v.capital.total).toBeCloseTo(500, 0); // BTC/ETH keep moving after init
    expect(v.capital).toMatchObject({ protected: 400, cash: 100 });
  });

  it("pump → strategy → risk APPROVED → paper fill → position → exit → rotation BTC/ETH", async () => {
    const h = await harness("PAPER");
    h.run(420);
    h.pump("SOL-EUR");
    h.run(600);
    const t = h.types();
    const i = (x: string) => t.indexOf(x as never);
    expect(i("STRATEGY_TRIGGERED")).toBeGreaterThan(-1);
    expect(i("RISK_CHECK")).toBeGreaterThan(i("STRATEGY_TRIGGERED"));
    expect(i("ORDER_APPROVED")).toBeGreaterThan(i("RISK_CHECK"));
    expect(i("ORDER_SUBMITTED")).toBeGreaterThan(i("ORDER_APPROVED"));
    expect(i("ORDER_FILLED")).toBeGreaterThan(i("ORDER_SUBMITTED"));
    expect(i("POSITION_OPENED")).toBeGreaterThan(i("ORDER_FILLED"));
    expect(i("POSITION_CLOSED")).toBeGreaterThan(i("POSITION_OPENED"));
    expect(i("ROTATION_PLANNED")).toBeGreaterThan(i("POSITION_CLOSED"));

    const opened = h.events.find((e) => e.type === "POSITION_OPENED")!;
    expect(opened.productId).toBe("SOL-EUR");
    expect(opened.strategy).toBe("bump-momentum");

    const trades = h.trading.tradesList();
    expect(trades.length).toBeGreaterThanOrEqual(1);
    const tr = trades.find((x) => x.productId === "SOL-EUR")!;
    expect(tr.fees).toBeGreaterThan(0);
    expect(tr.highestPrice).toBeGreaterThanOrEqual(tr.entryPrice);
    expect(["TRAILING_STOP", "STOP_LOSS", "MAX_DURATION"]).toContain(tr.exitReason);
    expect(tr.costQuote).toBeLessThanOrEqual(10 + 1e-9);

    const v = h.trading.view();
    expect(v.performance.trades).toBe(trades.length);
    expect(v.performance.totalFees).toBeGreaterThan(0);
    expect(h.invariants).toEqual([]);
    // Rotation moved the proceeds to BTC/ETH: cash went down vs 100 − P&L effects.
    expect(h.events.filter((e) => e.type === "ORDER_FILLED" && (e.productId === "BTC-EUR" || e.productId === "ETH-EUR")).length).toBe(2);
  });

  it("emergency stop blocks new entries but protective exits still work", async () => {
    const h = await harness("PAPER");
    h.run(420);
    h.trading.emergencyStop("test");
    h.pump("SOL-EUR");
    h.run(200);
    expect(h.types()).toContain("BOT_STOPPED");
    const rejected = h.events.filter((e) => e.type === "ORDER_REJECTED" && e.productId === "SOL-EUR");
    expect(rejected.length).toBeGreaterThan(0);
    expect(String(rejected[0]!.message)).toMatch(/emergency_stop/);
    expect(h.types()).not.toContain("POSITION_OPENED");
    expect(h.trading.view().riskLevel).toBe("BLOCKED");

    // Re-activation is manual.
    expect(h.trading.resume("all").map((b) => b.id)).toContain("EMERGENCY_STOP");
    expect(h.trading.view().emergencyStop).toBeNull();
  });

  it("an open position is still closed after an emergency stop", async () => {
    const h = await harness("PAPER", testConfig({ rotation: false }));
    h.run(420);
    h.pump("SOL-EUR");
    let stopped = false;
    h.run(600, () => {
      if (!stopped && h.trading.view().positions.length > 0) {
        stopped = true;
        h.trading.emergencyStop("pendant une position");
      }
    });
    expect(stopped).toBe(true);
    expect(h.types()).toContain("POSITION_CLOSED");
    expect(h.trading.view().positions).toEqual([]);
  });

  it("RADAR mode runs the same pipeline without executing anything", async () => {
    const h = await harness("RADAR");
    h.run(420);
    h.pump("SOL-EUR");
    h.run(200);
    const approved = h.events.filter((e) => e.type === "ORDER_APPROVED");
    expect(approved.length).toBeGreaterThan(0);
    expect(approved.every((e) => e.data?.executed === false)).toBe(true);
    for (const t of ["ORDER_SUBMITTED", "ORDER_FILLED", "POSITION_OPENED"]) expect(h.types()).not.toContain(t);
    expect(h.trading.view().capital.cash).toBe(100);
    expect(h.trading.proposals("SOL-EUR")[0]).toMatchObject({ strategyId: "bump-momentum" });
  });

  it("persists state and restores it after a restart (paper)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "radar-paper-"));
    const h = await harness("PAPER", testConfig(), dir);
    h.run(420);
    h.pump("SOL-EUR");
    let opened = false;
    h.run(400, () => {
      if (!opened && h.trading.view().positions.length > 0) opened = true;
    });
    h.trading.emergencyStop("persisté");
    const before = h.trading.view();
    const h2 = await harness("PAPER", testConfig(), dir);
    const after = h2.trading.view();
    expect(after.initialized).toBe(true);
    expect(after.capital.cash).toBeCloseTo(before.capital.cash, 9);
    expect(after.performance.trades).toBe(before.performance.trades);
    expect(after.emergencyStop?.reason).toBe("persisté");
    expect(opened).toBe(true);
  });

  it("refuses to start on a corrupted state file (never resets silently)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "radar-paper-"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(dir, "state.json"), JSON.stringify({ version: 1, portfolio: { cash: "lots" } }));
    await expect(harness("PAPER", testConfig(), dir)).rejects.toThrow(/état paper invalide/);
  });

  it("reset clears the paper portfolio but keeps the emergency stop", async () => {
    const h = await harness("PAPER");
    h.run(420);
    h.pump("SOL-EUR");
    h.run(600);
    h.trading.emergencyStop("x");
    expect(h.trading.reset()).toEqual({ ok: true });
    const v = h.trading.view();
    expect(v.initialized).toBe(false);
    expect(v.performance.trades).toBe(0);
    expect(v.emergencyStop).not.toBeNull();
    h.run(2);
    expect(h.trading.view().initialValue).toBeCloseTo(500, 6);
  });
});

describe("Strategy Builder (server side)", () => {
  const base = () => structuredClone(testConfig().strategies[0]!);

  it("creates, persists and reloads strategies; logs every change", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "radar-strat-"));
    const h = await harness("RADAR", testConfig(), null, dir);
    const r = h.trading.upsertStrategy({ ...base(), id: "my-strat", name: "Ma stratégie", sizing: { quoteAmount: 5 } });
    expect(r.ok).toBe(true);
    expect(h.trading.listStrategies().map((s) => s.id)).toEqual(["bump-momentum", "my-strat"]);
    expect(h.types()).toContain("STRATEGY_CREATED");
    const upd = h.trading.upsertStrategy({ ...base(), id: "my-strat", name: "Renommée", sizing: { quoteAmount: 7 } });
    expect(upd).toMatchObject({ ok: true, created: false });
    expect(h.types()).toContain("STRATEGY_UPDATED");
    const h2 = await harness("RADAR", testConfig(), null, dir);
    expect(h2.trading.listStrategies().find((s) => s.id === "my-strat")).toMatchObject({ name: "Renommée", sizing: { quoteAmount: 7 } });
  });

  it("ATTACK: a strategy cannot exceed the Risk Engine limits nor skip the stop loss", async () => {
    const h = await harness("RADAR");
    const big = h.trading.upsertStrategy({ ...base(), id: "big", sizing: { quoteAmount: 1000 } });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.issues.join(" ")).toMatch(/maximum par trade/);
    const noStop = h.trading.upsertStrategy({ ...base(), id: "nostop", exit: { trailingStopPct: 2 } });
    expect(noStop.ok).toBe(false);
    const badId = h.trading.upsertStrategy({ ...base(), id: "../../etc" });
    expect(badId.ok).toBe(false);
    expect(h.trading.listStrategies().map((s) => s.id)).toEqual(["bump-momentum"]);
  });

  it("disabling a strategy stops new entries", async () => {
    const h = await harness("PAPER");
    expect(h.trading.setStrategyEnabled("bump-momentum", false)).toEqual({ ok: true });
    h.run(420);
    h.pump("SOL-EUR");
    h.run(200);
    expect(h.types()).not.toContain("STRATEGY_TRIGGERED");
  });

  it("editing a strategy keeps the rules of open positions; deletion waits for them to close", async () => {
    const h = await harness("PAPER", testConfig({ rotation: false }));
    h.run(420);
    h.pump("SOL-EUR");
    let checked = false;
    h.run(600, () => {
      const v = h.trading.view();
      if (!checked && v.positions.length > 0) {
        checked = true;
        const pos = v.positions[0]!;
        expect(h.trading.deleteStrategy(pos.strategyId).ok).toBe(false);
        h.trading.upsertStrategy({ ...base(), exit: { stopLossPct: 2, trailingStopPct: 10, takeProfitPct: null, maxDurationSec: 300 } });
        expect(h.trading.view().positions[0]!.trailingStopPct).toBe(1);
      }
    });
    expect(checked).toBe(true);
    expect(h.trading.view().positions).toEqual([]);
    expect(h.trading.deleteStrategy("bump-momentum")).toEqual({ ok: true });
    expect(h.types()).toContain("STRATEGY_DELETED");
  });

  it("previews an unsaved strategy on the live market without storing it", async () => {
    const h = await harness("RADAR");
    h.run(420);
    h.pump("SOL-EUR");
    let seen = false;
    h.run(150, () => {
      if (seen) return;
      const p = h.trading.previewStrategy({ ...base(), id: "draft" });
      if (p.matches.some((m) => m.productId === "SOL-EUR")) {
        seen = true;
        expect(p.valid).toBe(true);
        expect(p.matches.find((m) => m.productId === "SOL-EUR")!.risk).not.toBeNull();
      }
    });
    expect(seen).toBe(true);
    const calm = h.trading.previewStrategy({ ...base(), id: "draft" });
    expect(calm.evaluated).toBeGreaterThan(5);
    expect(h.trading.listStrategies().map((s) => s.id)).toEqual(["bump-momentum"]);
    expect(h.trading.previewStrategy({ id: "x" })).toMatchObject({ valid: false });
  });

  it("refuses to start on a corrupted strategies file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "radar-strat-"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(dir, "strategies.json"), JSON.stringify({ version: 1, savedAt: "x", strategies: [{ id: "a" }] }));
    await expect(harness("RADAR", testConfig(), null, dir)).rejects.toThrow(/stratégies invalide/);
  });
});

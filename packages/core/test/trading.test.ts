import { describe, expect, it } from "vitest";
import { Prng } from "../src/simulation/prng.js";
import { CircuitBreakers, type BreakerInputs } from "../src/trading/breakers.js";
import { StrategySchema, TradingConfigSchema, DEFAULT_STRATEGY } from "../src/trading/config.js";
import { computePerformance } from "../src/trading/metrics.js";
import { simulateMarketOrder } from "../src/trading/paper-execution.js";
import { applyExitFill, checkExit, markPosition, openPosition, toTradeRecord, unrealizedPnl } from "../src/trading/positions.js";
import { planRotation } from "../src/trading/rotation.js";
import { findEntryCandidates } from "../src/trading/strategy.js";
import type { Fill, TradeRecord } from "../src/trading/types.js";
import { T0 } from "./helpers.js";
import { entry, metrics, row, tradingConfig } from "./trading-helpers.js";

const strategy = StrategySchema.parse(DEFAULT_STRATEGY);
const paper = tradingConfig().paper;
const book = { bid: 99.95, ask: 100.05, bidQty: 100, askQty: 100 };
const rules = { baseIncrement: 0.0001, baseMinSize: 0.001, quoteMinSize: 1 };
const noRandom = { ...paper, baseSlippageBps: 0, unfilledProbability: 0 };

function fill(o: Partial<Fill> = {}): Fill {
  return { orderId: "o", ts: T0, productId: "SOL-EUR", side: "BUY", requestedPrice: 100, price: 100, baseQty: 0.1, quoteGross: 10, fee: 0.12, slippageQuote: 0, slippagePct: 0, partial: false, latencyMs: 0, ...o };
}

describe("config", () => {
  it("defaults follow the specification example", () => {
    const c = tradingConfig();
    expect(c.portfolio).toMatchObject({ currency: "EUR", protectedCapital: 400, initial: { cash: 100, holdings: { BTC: 200, ETH: 200 } } });
    expect(c.risk.maxTradeQuote).toBe(10);
    expect(c.strategies[0]!.exit).toMatchObject({ stopLossPct: 2, trailingStopPct: 2 });
  });
  it("refuses a strategy without stop loss, above max trade, or with rotation > 100 %", () => {
    const { exit, ...noExit } = DEFAULT_STRATEGY;
    void exit;
    expect(() => StrategySchema.parse(noExit)).toThrow();
    expect(() => StrategySchema.parse({ ...DEFAULT_STRATEGY, exit: { trailingStopPct: 2 } })).toThrow();
    expect(() => TradingConfigSchema.parse({ strategies: [{ ...DEFAULT_STRATEGY, sizing: { quoteAmount: 50 } }] })).toThrow();
    expect(() =>
      StrategySchema.parse({ ...DEFAULT_STRATEGY, afterExit: { rotation: { enabled: true, allocations: { BTC: 80, ETH: 40 } } } }),
    ).toThrow();
  });
});

describe("Strategy Engine", () => {
  it("triggers only when every condition holds", () => {
    const hot = row(metrics("SOL-EUR", { changes: { "10s": 1, "30s": 2, "1m": 3.5, "5m": 4 }, volumeRatio: 2.5, spreadPct: 0.1 }), 75);
    const weakVolume = row(metrics("AVAX-EUR", { volumeRatio: 1.5 }), 75);
    const lowScore = row(metrics("ADA-EUR"), 60);
    const wrongQuote = row(metrics("SOL-USDC"), 90);
    const unknown = row(metrics("DOT-EUR", { changes: { "10s": null, "30s": null, "1m": null, "5m": null } }), 90);
    const c = findEntryCandidates([strategy], [hot, weakVolume, lowScore, wrongQuote, unknown]);
    expect(c.map((x) => x.row.metrics.productId)).toEqual(["SOL-EUR"]);
    expect(c[0]!.reason).toMatch(/Prix 1m > 3 %/);
  });
  it("ignores disabled strategies and excluded bases", () => {
    const hot = row(metrics("SOL-EUR"), 90);
    expect(findEntryCandidates([{ ...strategy, enabled: false }], [hot])).toEqual([]);
    expect(findEntryCandidates([{ ...strategy, universe: { quoteCurrencies: ["EUR"], excludeBases: ["SOL"] } }], [hot])).toEqual([]);
  });
});

describe("positions: stop from entry vs trailing stop", () => {
  it("stop from entry: 100 → 98 exits with STOP_LOSS", () => {
    const p = openPosition("p", entry(), fill(), { ...strategy, exit: { ...strategy.exit, trailingStopPct: null } }, "SOL");
    expect(p.stopLevel).toBeCloseTo(98);
    markPosition(p, 98.5, T0 + 1000, strategy);
    expect(checkExit(p, T0 + 1000)).toBeNull();
    markPosition(p, 97.9, T0 + 2000, strategy);
    expect(checkExit(p, T0 + 2000)).toBe("STOP_LOSS");
  });

  it("trailing stop follows the highest price: 100 → 105 → 110, exit at 107.8", () => {
    const p = openPosition("p", entry(), fill(), strategy, "SOL");
    for (const px of [105, 110, 109]) markPosition(p, px, T0, strategy);
    expect(p.highestPrice).toBe(110);
    expect(p.trailingLevel).toBeCloseTo(107.8);
    expect(p.stopLevel).toBeCloseTo(98);
    expect(checkExit(p, T0)).toBeNull();
    markPosition(p, 107.7, T0, strategy);
    expect(checkExit(p, T0)).toBe("TRAILING_STOP");
  });

  it("take profit and max duration", () => {
    const s = { ...strategy, exit: { ...strategy.exit, takeProfitPct: 5, maxDurationSec: 60 } };
    const p = openPosition("p", entry(), fill(), s, "SOL");
    markPosition(p, 105, T0, s);
    expect(checkExit(p, T0)).toBe("TAKE_PROFIT");
    const q = openPosition("q", entry(), fill(), s, "SOL");
    expect(checkExit(q, T0 + 59_000)).toBeNull();
    expect(checkExit(q, T0 + 60_000)).toBe("MAX_DURATION");
  });

  it("records entry, highest, exit and P&L including fees, across partial exits", () => {
    const p = openPosition("p", entry(), fill({ fee: 0.12 }), strategy, "SOL");
    markPosition(p, 110, T0, strategy);
    expect(unrealizedPnl(p)).toBeCloseTo(0.1 * 110 - 10.12);
    const done1 = applyExitFill(p, fill({ side: "SELL", price: 108, baseQty: 0.06, quoteGross: 6.48, fee: 0.08, ts: T0 + 5000 }), "TRAILING_STOP", 0.0001);
    expect(done1).toBe(false);
    expect(p.status).toBe("open");
    const done2 = applyExitFill(p, fill({ side: "SELL", price: 107, baseQty: 0.04, quoteGross: 4.28, fee: 0.05, ts: T0 + 6000 }), "TRAILING_STOP", 0.0001);
    expect(done2).toBe(true);
    const t = toTradeRecord("t", p, 500);
    expect(t.exitPrice).toBeCloseTo((108 * 0.06 + 107 * 0.04) / 0.1);
    expect(t.pnl).toBeCloseTo(6.4 + 4.23 - 10.12);
    expect(t.fees).toBeCloseTo(0.12 + 0.08 + 0.05);
    expect(t.highestPrice).toBe(110);
    expect(t.exitReason).toBe("TRAILING_STOP");
  });
});

function fillOf(r: ReturnType<typeof simulateMarketOrder>): Fill {
  if (!("fill" in r)) throw new Error(`not filled: ${r.status}`);
  return r.fill;
}

describe("paper execution", () => {
  it("buys at the ask with fees included in the amount", () => {
    const r = simulateMarketOrder("o", entry({ quoteSize: 10 }), book, rules, noRandom, new Prng(1), T0, 200);
    expect(r.status).toBe("FILLED");
    if (r.status !== "FILLED") return;
    const f = r.fill;
    expect(f.price).toBeGreaterThan(100.05);
    expect(f.quoteGross + f.fee).toBeLessThanOrEqual(10 + 1e-9);
    expect(f.fee).toBeCloseTo(f.quoteGross * 0.012, 9);
    expect(f.slippagePct).toBeGreaterThan(0);
    expect(f.latencyMs).toBe(200);
  });

  it("sells at the bid and deducts fees from proceeds", () => {
    const r = simulateMarketOrder("o", entry({ side: "SELL", kind: "EXIT", quoteSize: null, baseSize: 0.1 }), book, rules, noRandom, new Prng(1), T0, 0);
    if (r.status !== "FILLED") throw new Error(r.status);
    expect(r.fill.price).toBeLessThan(99.95);
    expect(r.fill.baseQty).toBeCloseTo(0.1);
  });

  it("slippage grows with order size vs top-of-book depth", () => {
    const small = simulateMarketOrder("o", entry({ quoteSize: 10 }), book, rules, noRandom, new Prng(1), T0, 0);
    const big = simulateMarketOrder("o", entry({ quoteSize: 10 }), { ...book, askQty: 0.2 }, rules, noRandom, new Prng(1), T0, 0);
    expect(fillOf(big).slippagePct).toBeGreaterThan(fillOf(small).slippagePct);
  });

  it("partially fills orders larger than the available depth", () => {
    const r = simulateMarketOrder("o", entry({ quoteSize: 10 }), { ...book, askQty: 0.01 }, rules, noRandom, new Prng(1), T0, 0);
    expect(r.status).toBe("PARTIALLY_FILLED");
    if (r.status !== "PARTIALLY_FILLED") return;
    expect(r.fill.partial).toBe(true);
    expect(r.fill.quoteGross).toBeLessThan(4);
  });

  it("simulates unfilled orders and missing books", () => {
    const always = { ...noRandom, unfilledProbability: 1 };
    expect(simulateMarketOrder("o", entry(), book, rules, always, new Prng(1), T0, 0).status).toBe("UNFILLED");
    expect(simulateMarketOrder("o", entry(), { ...book, ask: null }, rules, noRandom, new Prng(1), T0, 0).status).toBe("UNFILLED");
  });

  it("respects base increments and minimum sizes", () => {
    const r = simulateMarketOrder("o", entry({ quoteSize: 10 }), book, { ...rules, baseIncrement: 0.01 }, noRandom, new Prng(1), T0, 0);
    if (r.status !== "FILLED") throw new Error();
    expect(r.fill.baseQty).toBeCloseTo(0.09);
    expect(simulateMarketOrder("o", entry({ quoteSize: 0.5 }), book, rules, noRandom, new Prng(1), T0, 0).status).toBe("REJECTED");
  });
});

describe("circuit breakers", () => {
  const base: BreakerInputs = {
    now: T0,
    feedHealthy: true,
    feedReason: null,
    lossUsed24h: 0,
    lossUsed7d: 0,
    maxDailyLoss: 5,
    maxWeeklyLoss: 15,
    consecutiveErrors: 0,
    maxConsecutiveErrors: 3,
    executionRejectionsLastHour: 0,
    maxExecutionRejectionsPerHour: 10,
    fillsLastHour: 0,
    maxTradesPerHour: 6,
  };
  it("trips on each condition", () => {
    const b = new CircuitBreakers();
    const changes = b.evaluate({ ...base, lossUsed24h: 5, lossUsed7d: 20, consecutiveErrors: 3, executionRejectionsLastHour: 10, fillsLastHour: 13 });
    expect(changes.map((c) => c.breaker.id).sort()).toEqual(["API_ERRORS", "DAILY_LOSS", "EXECUTION_REJECTIONS", "TRADE_RATE", "WEEKLY_LOSS"]);
    expect(b.evaluate({ ...base, lossUsed24h: 5 })).toEqual([]); // no duplicate trip
  });
  it("manual breakers need a manual reset; stale data recovers automatically", () => {
    const b = new CircuitBreakers();
    b.evaluate({ ...base, lossUsed24h: 6, feedHealthy: false, feedReason: "x" });
    expect(b.list().map((x) => x.id).sort()).toEqual(["DAILY_LOSS", "STALE_DATA"]);
    const rec = b.evaluate({ ...base });
    expect(rec).toEqual([expect.objectContaining({ kind: "recovered" })]);
    expect(b.isTripped("DAILY_LOSS")).toBe(true);
    b.reset(["DAILY_LOSS"]);
    expect(b.list()).toEqual([]);
  });
  it("emergency stop persists across restarts, auto breakers do not", () => {
    const b = new CircuitBreakers();
    b.trip("EMERGENCY_STOP", "manuel", T0);
    b.trip("STALE_DATA", "x", T0, false);
    const restored = new CircuitBreakers(b.list());
    expect(restored.list().map((x) => x.id)).toEqual(["EMERGENCY_STOP"]);
  });
});

describe("rotation BTC/ETH", () => {
  const trade = (pnl: number, proceeds: number) => ({ pnl, proceedsQuote: proceeds, productId: "SOL-EUR" }) as TradeRecord;
  const rot = (mode: "proceeds" | "profit_only") => ({ ...strategy, afterExit: { rotation: { enabled: true, mode, allocations: { BTC: 50, ETH: 50 }, minOrderQuote: 1 } } });
  let n = 0;
  const id = () => `r${++n}`;

  it("spec example: SOL stopped out at 10 € → 5 € BTC + 5 € ETH (proceeds mode)", () => {
    const plan = planRotation(trade(-0.2, 10), rot("proceeds"), "EUR", () => 100, id, T0);
    expect(plan.intents.map((i) => [i.productId, i.quoteSize])).toEqual([["BTC-EUR", 5], ["ETH-EUR", 5]]);
    expect(plan.intents.every((i) => i.kind === "ROTATION" && i.side === "BUY")).toBe(true);
  });
  it("profit_only rotates nothing after a loss and skips tiny amounts", () => {
    expect(planRotation(trade(-1, 9), rot("profit_only"), "EUR", () => 100, id, T0).intents).toEqual([]);
    const small = planRotation(trade(1.5, 11.5), rot("profit_only"), "EUR", () => 100, id, T0);
    expect(small.intents).toEqual([]);
    expect(small.skipped).toHaveLength(2);
  });
  it("is optional", () => {
    expect(planRotation(trade(5, 15), strategy.afterExit.rotation.enabled ? { ...strategy, afterExit: { rotation: { ...strategy.afterExit.rotation, enabled: false } } } : strategy, "EUR", () => 1, id, T0).intents).toEqual([]);
  });
});

describe("performance stats", () => {
  it("win rate, profit factor, averages, drawdown, fees", () => {
    const t = (pnl: number, closedAt: number) => ({ pnl, closedAt, fees: 0.2, slippageQuote: 0.05 }) as TradeRecord;
    const s = computePerformance([t(2, 1), t(-1, 2), t(-2, 3), t(3, 4)], -0.5, []);
    expect(s).toMatchObject({ trades: 4, wins: 2, losses: 2, winRatePct: 50, realizedPnl: 2, tradingPnl: 1.5, avgWin: 2.5, avgLoss: -1.5 });
    expect(s.profitFactor).toBeCloseTo(5 / 3);
    expect(s.maxDrawdown).toBeCloseTo(3);
    expect(s.totalFees).toBeCloseTo(0.8);
    expect(s.totalSlippage).toBeCloseTo(0.2);
  });
});

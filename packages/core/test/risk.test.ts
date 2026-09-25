import { describe, expect, it } from "vitest";
import { checkIntent, lossUsed } from "../src/trading/risk.js";
import { applyBuyFill, capitalBreakdown, updateMark } from "../src/trading/portfolio.js";
import { product, T0 } from "./helpers.js";
import { ctx, entry, metrics, portfolio, position, tradingConfig } from "./trading-helpers.js";

const failed = (d: ReturnType<typeof checkIntent>) => d.checks.filter((c) => !c.passed).map((c) => c.name);

describe("Risk Engine — entries", () => {
  it("approves a sane 10 € entry and runs every check", () => {
    const d = checkIntent(entry(), ctx());
    expect(d.reasons).toEqual([]);
    expect(d.approved).toBe(true);
    expect(d.checks.length).toBeGreaterThanOrEqual(20);
  });

  it("ATTACK: trade larger than max trade size", () => {
    expect(failed(checkIntent(entry({ quoteSize: 50 }), ctx()))).toContain("max_trade_size");
  });

  it("ATTACK: tries to use protected capital (only 100 € tradable)", () => {
    const cfg = tradingConfig({ risk: { maxTradeQuote: 500, maxExposurePerAssetQuote: 500, maxTotalExposureQuote: 500 }, strategies: [] });
    const d = checkIntent(entry({ quoteSize: 150 }), ctx({ cfg }));
    expect(d.approved).toBe(false);
    expect(failed(d)).toEqual(expect.arrayContaining(["capital_available", "protected_capital"]));
  });

  it("protected capital shrinks tradable capital when BTC/ETH fall", () => {
    const cfg = tradingConfig();
    const pf = portfolio(cfg);
    updateMark(pf, "BTC", 60_000, T0); // core BTC 200 € → 120 €: total 420, tradable 20
    const c = ctx({ cfg, portfolio: pf });
    expect(c.capital.tradable).toBeCloseTo(20, 6);
    const pos = position({ baseQty: 0.15, initialBaseQty: 0.15, costQuote: 15 });
    const c2 = ctx({ cfg, portfolio: pf, positions: [pos] });
    const d = checkIntent(entry({ quoteSize: 10 }), c2);
    expect(failed(d)).toEqual(expect.arrayContaining(["capital_available", "protected_capital"]));
  });

  it("ATTACK: exceeds max open positions", () => {
    const positions = ["A", "B", "C"].map((x, i) => position({ id: `p${i}`, productId: `${x}-EUR`, baseCurrency: x }));
    expect(failed(checkIntent(entry(), ctx({ positions })))).toContain("max_positions");
  });

  it("ATTACK: exposure limits per asset and total", () => {
    const cfg = tradingConfig({ risk: { maxExposurePerAssetQuote: 15, maxTotalExposureQuote: 15, maxOpenPositions: 10 } });
    const positions = [position({ productId: "SOL-USDC", baseCurrency: "SOL", baseQty: 0.08, initialBaseQty: 0.08, costQuote: 8 })];
    const d = checkIntent(entry(), ctx({ cfg, positions }));
    expect(failed(d)).toEqual(expect.arrayContaining(["exposure_asset", "exposure_total"]));
  });

  it("ATTACK: daily loss limit reached (realized)", () => {
    const d = checkIntent(entry(), ctx({ history: { realizedPnl24h: -5, realizedPnl7d: -5, entriesLastHour: 0, entriesLastDay: 0, lastLossAt: null, consecutiveErrors: 0 } }));
    expect(failed(d)).toContain("daily_loss");
  });

  it("counts unrealized losses (not gains) against the daily limit", () => {
    const cfg = tradingConfig();
    const losing = position({ lastPrice: 60 }); // 0.1 × 60 − 10 = −4 (− exit fee)
    expect(lossUsed(0, [losing], cfg)).toBeGreaterThan(4);
    const winning = position({ lastPrice: 200 });
    expect(lossUsed(-1, [winning], cfg)).toBe(1);
    const d = checkIntent(entry({ productId: "SOL-EUR" }), ctx({ positions: [position({ productId: "AVAX-EUR", baseCurrency: "AVAX", lastPrice: 45 })] }));
    expect(failed(d)).toContain("daily_loss");
  });

  it("ATTACK: weekly loss, trade count, cooldown after loss, previous errors", () => {
    const d = checkIntent(
      entry(),
      ctx({ history: { realizedPnl24h: 0, realizedPnl7d: -20, entriesLastHour: 6, entriesLastDay: 6, lastLossAt: T0, consecutiveErrors: 3 } }),
    );
    expect(failed(d)).toEqual(expect.arrayContaining(["weekly_loss", "trade_count", "cooldown_after_loss", "previous_errors"]));
  });

  it("ATTACK: spread too wide, illiquid, slippage too high", () => {
    const m = metrics("SOL-EUR", { bestBid: 98, bestAsk: 102, spreadPct: 4, bestAskQty: 0.05, bestBidQty: 0.05, topBookDepthQuote: 10, volume24hQuote: 1000 });
    const d = checkIntent(entry({ referencePrice: 100 }), ctx({ metrics: m }));
    expect(failed(d)).toEqual(expect.arrayContaining(["spread", "liquidity", "estimated_slippage"]));
  });

  it("ATTACK: stale data / feed down / unknown product / wrong quote currency", () => {
    const stale = checkIntent(entry(), ctx({ metrics: metrics("SOL-EUR", { lastReceivedAt: T0 - 60_000 }) }));
    expect(failed(stale)).toContain("data_freshness");
    const down = checkIntent(entry(), ctx({ feed: { healthy: false, reason: "heartbeats absents", state: "reconnecting" } }));
    expect(failed(down)).toEqual(expect.arrayContaining(["data_freshness", "exchange_status"]));
    expect(failed(checkIntent(entry(), ctx({ product: undefined })))).toContain("product_eligible");
    const usdc = checkIntent(entry({ productId: "SOL-USDC" }), ctx({ product: product("SOL-USDC") }));
    expect(failed(usdc)).toContain("product_eligible");
    const limitOnly = checkIntent(entry(), ctx({ product: product("SOL-EUR", { flags: { ...product("x").flags, limitOnly: true } }) }));
    expect(failed(limitOnly)).toContain("product_eligible");
  });

  it("refuses products not available to the connected Coinbase account", () => {
    expect(failed(checkIntent(entry(), ctx({ accountProducts: new Set(["BTC-EUR"]) })))).toContain("product_eligible");
    expect(checkIntent(entry(), ctx({ accountProducts: new Set(["SOL-EUR"]) })).approved).toBe(true);
  });

  it("ATTACK: incoherent price", () => {
    expect(failed(checkIntent(entry({ referencePrice: 130 }), ctx()))).toContain("price_sanity");
    expect(failed(checkIntent(entry(), ctx({ metrics: metrics("SOL-EUR", { bestBid: 101, bestAsk: 100 }) })))).toContain("price_sanity");
  });

  it("ATTACK: below product minimum size", () => {
    expect(failed(checkIntent(entry({ quoteSize: 0.5 }), ctx()))).toContain("min_order_size");
  });

  it("ATTACK: duplicate position / pending order on the same product", () => {
    expect(failed(checkIntent(entry(), ctx({ positions: [position()] })))).toContain("duplicate_position");
    expect(failed(checkIntent(entry(), ctx({ pendingProductIds: new Set(["SOL-EUR"]) })))).toContain("duplicate_position");
  });

  it("ATTACK: parallel entries — orders in flight count against capital and positions", () => {
    const d = checkIntent(entry(), ctx({ pendingEntries: { count: 3, quote: 95 } }));
    expect(failed(d)).toEqual(expect.arrayContaining(["capital_available", "max_positions", "exposure_total"]));
  });

  it("emergency stop and circuit breakers block every entry", () => {
    const e = checkIntent(entry(), ctx({ emergencyStop: { active: true, reason: "manuel" } }));
    expect(failed(e)).toEqual(["emergency_stop"]);
    const b = checkIntent(entry(), ctx({ trippedBreakers: [{ id: "API_ERRORS", reason: "3 erreurs" }] }));
    expect(failed(b)).toEqual(["circuit_breakers"]);
  });

  it("refuses short selling as an entry", () => {
    expect(checkIntent(entry({ side: "SELL" }), ctx()).approved).toBe(false);
  });
});

describe("Risk Engine — exits and rotations", () => {
  const exit = (o = {}) => entry({ kind: "EXIT", side: "SELL", quoteSize: null, baseSize: 0.1, positionId: "p1", ...o });

  it("never blocks a protective exit because of loss limits or emergency stop", () => {
    const d = checkIntent(
      exit(),
      ctx({
        positions: [position()],
        emergencyStop: { active: true, reason: "manuel" },
        trippedBreakers: [{ id: "DAILY_LOSS", reason: "x" }],
        history: { realizedPnl24h: -100, realizedPnl7d: -100, entriesLastHour: 99, entriesLastDay: 99, lastLossAt: T0, consecutiveErrors: 0 },
      }),
    );
    expect(d.reasons).toEqual([]);
  });

  it("ATTACK: selling more than the position, or protected core holdings", () => {
    expect(failed(checkIntent(exit({ baseSize: 1 }), ctx({ positions: [position()] })))).toContain("position_exists");
    const btc = exit({ productId: "BTC-EUR", positionId: null, baseSize: 0.001 });
    expect(failed(checkIntent(btc, ctx({ positions: [position()] })))).toContain("position_exists");
  });

  it("exits tolerate older data than entries, but not missing prices", () => {
    const m = metrics("SOL-EUR", { lastReceivedAt: T0 - 30_000 });
    expect(checkIntent(exit(), ctx({ positions: [position()], metrics: m })).approved).toBe(true);
    const gone = metrics("SOL-EUR", { lastReceivedAt: T0 - 120_000 });
    expect(checkIntent(exit(), ctx({ positions: [position()], metrics: gone })).approved).toBe(false);
  });

  it("rotations are blocked by the emergency stop and limited to cash", () => {
    const rot = entry({ kind: "ROTATION", productId: "BTC-EUR", referencePrice: 100, strategyId: "s" });
    const c = ctx({ product: product("BTC-EUR", { quoteMinSize: 1 }), metrics: metrics("BTC-EUR") });
    expect(checkIntent(rot, c).approved).toBe(true);
    expect(checkIntent(rot, { ...c, emergencyStop: { active: true, reason: null } }).approved).toBe(false);
    expect(failed(checkIntent({ ...rot, quoteSize: 1000 }, c))).toContain("capital_available");
  });
});

describe("capital breakdown", () => {
  it("matches the specification example", () => {
    const cfg = tradingConfig();
    const pf = portfolio(cfg);
    let c = capitalBreakdown(pf, [], cfg.portfolio);
    expect(c).toMatchObject({ total: 500, protected: 400, tradable: 100, engaged: 0, available: 100, cash: 100 });
    applyBuyFill(pf, "SOL", { orderId: "o", ts: T0, productId: "SOL-EUR", side: "BUY", requestedPrice: 100, price: 100, baseQty: 0.1, quoteGross: 10, fee: 0, slippageQuote: 0, slippagePct: 0, partial: false, latencyMs: 0 });
    c = capitalBreakdown(pf, [position()], cfg.portfolio);
    expect(c.cash).toBeCloseTo(90);
    expect(c.engaged).toBeCloseTo(10);
    expect(c.available).toBeCloseTo(90);
    expect(c.holdings.find((h) => h.asset === "SOL")).toMatchObject({ positionQty: 0.1, coreQty: 0 });
  });
});

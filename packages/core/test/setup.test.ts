import { describe, expect, it } from "vitest";
import { aggregateCandles, analyzeSetup, ema, liquidationPrice, parseBinanceKlines, parseCoinbaseCandles, positionSize, rsi, setupCandidate, type Candle } from "../src/index.js";

/** Deterministic series: drift per bar + a wave, small noise. */
function series(n: number, drift: number, start = 100, wave = 0.004): Candle[] {
  const out: Candle[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = p * (1 + drift + Math.sin(i / 5) * wave + Math.sin(i * 12.9898) * 0.001);
    const c = p;
    out.push({ t: i * 3_600_000, o, h: Math.max(o, c) * 1.003, l: Math.min(o, c) * 0.997, c, v: 1000 + (c > o ? 400 : 0) + (i % 7) * 30 });
  }
  return out;
}

describe("indicators", () => {
  it("EMA equals the SMA seed then smooths", () => {
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(Number.isNaN(e[0])).toBe(true);
    expect(e[2]).toBe(2);
    expect(e[3]).toBe(3);
  });
  it("RSI is 100 on a straight rise", () => {
    const r = rsi(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(r[29]).toBe(100);
  });
});

describe("parsers", () => {
  it("reads Binance klines and Coinbase candles in time order", () => {
    const b = parseBinanceKlines([[2000, "1", "2", "0.5", "1.5", "10"], [1000, "1", "2", "0.5", "1.2", "10"], ["x"]]);
    expect(b.map((c) => c.t)).toEqual([1000, 2000]);
    const c = parseCoinbaseCandles({ candles: [{ start: "2", low: "1", high: "3", open: "2", close: "2.5", volume: "5" }, { start: "1", low: "1", high: "3", open: "2", close: "2", volume: "5" }] });
    expect(c.map((x) => x.t)).toEqual([1000, 2000]);
    expect(aggregateCandles(series(9, 0), 4)).toHaveLength(2);
  });
});

describe("analyzeSetup", () => {
  it("calls LONG with a full plan in a clean uptrend", () => {
    const cs = series(260, 0.003);
    const s = analyzeSetup(cs, aggregateCandles(cs, 4), { btcTrend: 0.6, fundingPct: 0.01 }, { minRR: 1.2 });
    expect(s).not.toBeNull();
    expect(s!.side).toBe("LONG");
    expect(s!.score).toBeGreaterThan(35);
    expect(s!.stop).toBeLessThan(s!.entry.low);
    expect(s!.targets[0]!.price).toBeGreaterThan(s!.entry.high);
    expect(s!.maxSafeLeverage).toBeGreaterThanOrEqual(1);
    // Liquidation at the max safe leverage stays beyond the stop.
    const mid = (s!.entry.low + s!.entry.high) / 2;
    expect(liquidationPrice(mid, s!.maxSafeLeverage, "LONG")).toBeLessThan(s!.stop);
  });

  it("calls SHORT in a clean downtrend and warns against crowded shorts", () => {
    const cs = series(260, -0.003);
    const s = analyzeSetup(cs, aggregateCandles(cs, 4), { btcTrend: -0.6 }, { minRR: 1.2 });
    expect(s!.side).toBe("SHORT");
    expect(s!.score).toBeLessThan(-35);
    expect(s!.stop).toBeGreaterThan(s!.entry.high);
  });

  it("waits in a flat market", () => {
    const s = analyzeSetup(series(260, 0, 100, 0.01), null, {});
    expect(s!.bias).toBe("WAIT");
    expect(setupCandidate("X", null, s!, null)).toBeNull();
  });

  it("sizes the position from the risk", () => {
    const p = positionSize({ stopDistPct: 2, entry: { low: 99, high: 101 } }, 1000, 1);
    expect(p.riskUsd).toBe(10);
    expect(p.notional).toBe(500);
    expect(p.quantity).toBe(5);
  });

  it("turns a LONG setup into a SETUP_LONG signal", () => {
    const cs = series(260, 0.003);
    const s = analyzeSetup(cs, aggregateCandles(cs, 4), { btcTrend: 0.6 }, { minRR: 1 })!;
    const c = setupCandidate("ABC", "Abc", { ...s, bias: "LONG" }, null)!;
    expect(c.kind).toBe("SETUP_LONG");
    expect(c.source).toBe("setup");
    expect(c.reasons.at(-1)).toContain("pas un conseil");
  });
});

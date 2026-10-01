import { describe, expect, it } from "vitest";
import { scoreVerdict, stepVerdict, type TradeSetup, type VerdictMemory } from "../src/index.js";

const M = 60_000;
const setup = (score: number, side: "LONG" | "SHORT" = score >= 0 ? "LONG" : "SHORT"): TradeSetup =>
  ({ score, side, bias: "WAIT", stop: side === "LONG" ? 95 : 105, targets: [{ label: "", price: side === "LONG" ? 110 : 90, r: 1.5 }], entry: { low: 99, high: 100 }, atrPct: 1.5, factors: [{ id: "trend", label: "Tendance", value: Math.sign(score), weight: 25, note: "n" }] }) as unknown as TradeSetup;
const eval_ = (mem: VerdictMemory | null, score: number, price: number, t: number) => {
  const sc = scoreVerdict({ setup: setup(score), signals: [], talk: [], price, now: t });
  return stepVerdict(mem, sc, setup(score), price, t);
};

describe("trend verdict", () => {
  it("needs two confirmations at least 8 min apart before giving an opinion", () => {
    let r = eval_(null, 60, 100, 0);
    expect(r.mem.state).toBe("NEUTRAL");
    expect(r.change).toBeNull();
    r = eval_(r.mem, 60, 100, 3 * M); // too soon
    expect(r.change).toBeNull();
    r = eval_(r.mem, 60, 100, 10 * M);
    expect(r.change).toMatchObject({ from: "NEUTRAL", to: "UP" });
    expect(r.mem.invalidation).toBe(95);
  });

  it("does not flip on a short counter-move, but the invalidation level ends the opinion at once", () => {
    let r = eval_(null, 60, 100, 0);
    r = eval_(r.mem, 60, 100, 10 * M);
    const up = r.mem;
    // 20 min later the score turns bearish (a dump): held for 2 h, no flip.
    r = eval_(up, -40, 99, 30 * M);
    r = eval_(r.mem, -40, 99, 40 * M);
    expect(r.change).toBeNull();
    expect(r.mem.state).toBe("UP");
    // Price breaks 95 (invalidation): opinion over.
    r = eval_(r.mem, -40, 94, 50 * M);
    expect(r.change).toMatchObject({ from: "UP", to: "DOWN", why: "invalidation" });
  });

  it("after the holding time, a confirmed opposite reading replaces the opinion", () => {
    let r = eval_(null, 60, 100, 0);
    r = eval_(r.mem, 60, 100, 10 * M);
    r = eval_(r.mem, -60, 99, 150 * M);
    expect(r.change).toBeNull(); // first sighting
    r = eval_(r.mem, -60, 99, 160 * M);
    expect(r.change).toMatchObject({ from: "UP", to: "DOWN", why: "confirmé" });
  });

  it("recent signals and news move the score, weighted by reliability", () => {
    const now = 100 * M;
    const sig = (direction: "bullish" | "bearish", hitRate: number | null) => ({ direction, strength: 80, ts: now - 5 * M, kind: "PUMP_EARLY" as const, source: "binance" as const, hitRate });
    const base = scoreVerdict({ setup: setup(0), signals: [], talk: [], price: 100, now }).score;
    const good = scoreVerdict({ setup: setup(0), signals: [sig("bullish", 70), sig("bullish", 70)], talk: [{ direction: "bullish", ts: now }, { direction: "bullish", ts: now }, { direction: "bullish", ts: now }, { direction: "bullish", ts: now }], price: 100, now }).score;
    const weak = scoreVerdict({ setup: setup(0), signals: [sig("bullish", 20), sig("bullish", 20)], talk: [], price: 100, now }).score;
    expect(base).toBe(0);
    expect(good).toBeGreaterThan(30);
    expect(weak).toBeLessThan(good);
  });
});

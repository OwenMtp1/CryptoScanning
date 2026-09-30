import { describe, expect, it } from "vitest";
import { demoBuy, demoClose, createDemo, demoDeposit, loadDemo, demoOpen, demoSell, tickDemo, valueDemo, type DemoState } from "../src/index.js";

const t0 = Date.UTC(2026, 9, 1, 12);
const ok = (r: { ok: boolean; state?: DemoState; error?: string }) => {
  if (!r.ok) throw new Error(r.error);
  return r.state as DemoState;
};

describe("demo account", () => {
  it("deposit, buy and sell spot with fees and slippage", () => {
    let s = ok(demoDeposit(createDemo(t0), 1000, t0));
    s = ok(demoBuy(s, "SOL", 500, 100, t0));
    expect(s.cash).toBe(500);
    const q = s.spot.SOL!.qty;
    expect(q).toBeLessThan(5); // fee + slippage
    expect(q).toBeGreaterThan(4.98);
    expect(demoBuy(s, "SOL", 600, 100, t0).ok).toBe(false); // not enough cash
    s = ok(demoSell(s, "SOL", 1, 110, t0));
    expect(s.spot.SOL).toBeUndefined();
    expect(s.cash).toBeGreaterThan(1000); // +10 % minus costs
    expect(s.history[0]!.pnl).toBeGreaterThan(40);
  });

  it("leveraged LONG: profit on close, then a liquidation loses exactly the margin", () => {
    let s = ok(demoDeposit(createDemo(t0), 1000, t0));
    s = ok(demoOpen(s, { coin: "BTC", side: "LONG", leverage: 10, margin: 100, price: 100_000 }, t0));
    const p = s.positions[0]!;
    expect(p.liqPrice).toBeCloseTo(p.entry * 0.905, 0);
    // +2 % → about +20 % on the margin
    const v = valueDemo(s, () => 102_000);
    expect(v.positions[0]!.pnlPct).toBeGreaterThan(18);
    s = ok(demoClose(s, p.id, 102_000, t0 + 1000));
    expect(s.positions).toHaveLength(0);
    expect(s.cash).toBeGreaterThan(1015);
    // New position, price crashes through the liquidation
    s = ok(demoOpen(s, { coin: "BTC", side: "LONG", leverage: 20, margin: 100, price: 100_000 }, t0 + 2000));
    const cash = s.cash;
    const r = tickDemo(s, () => 90_000, t0 + 3000);
    expect(r.events[0]).toMatch(/liquidé/);
    expect(r.state.positions).toHaveLength(0);
    expect(r.state.cash).toBe(cash); // margin gone, nothing back
    expect(r.state.history[0]).toMatchObject({ type: "LIQUIDATION", pnl: -100 });
  });

  it("SHORT with stop and take-profit, and bounds are enforced", () => {
    let s = ok(demoDeposit(createDemo(t0), 1000, t0));
    expect(demoOpen(s, { coin: "ETH", side: "SHORT", leverage: 5, margin: 100, price: 3000, stop: 2900 }, t0).ok).toBe(false); // stop on the wrong side
    expect(demoOpen(s, { coin: "ETH", side: "SHORT", leverage: 30, margin: 100, price: 3000, maxLeverage: 25 }, t0).ok).toBe(false);
    s = ok(demoOpen(s, { coin: "ETH", side: "SHORT", leverage: 5, margin: 100, price: 3000, stop: 3150, takeProfit: 2700 }, t0));
    const r = tickDemo(s, () => 2690, t0 + 60_000);
    expect(r.events[0]).toMatch(/Objectif/);
    expect(r.state.history[0]!.type).toBe("TAKE_PROFIT");
    expect(r.state.history[0]!.pnl).toBeGreaterThan(40); // −10 % × 5 ≈ +50 % of 100 $
    expect(valueDemo(r.state, () => 2690).stats).toMatchObject({ trades: 1, wins: 1 });
  });

  it("corrupted storage gives a fresh account", () => {
    expect(loadDemo({ version: 1, cash: "lots" }, t0).cash).toBe(0);
  });
});

/**
 * Demo account (fake money) for the live site: spot buy / sell and leveraged LONG / SHORT positions on
 * any crypto the site has a price for. Pure functions over a plain JSON state (kept in the browser).
 *
 * Execution model (approximate, on purpose simple and conservative):
 * - market orders at the last price ± slippage (0.05 % + size impact), taker fees
 *   (spot 0.10 %, perpetuals 0.05 % of the notional, charged at open and at close);
 * - isolated margin: liquidation when the loss reaches the margin minus a 0.5 % maintenance margin;
 * - stop-loss / take-profit checked on every price update (filled at the trigger price ± slippage);
 * - funding is not simulated.
 * It never places real orders.
 */
import { z } from "zod";

export const DEMO_FEES = { spotPct: 0.1, perpPct: 0.05, slippagePct: 0.05, maintenancePct: 0.5 } as const;
export const DEMO_MAX_LEVERAGE = 100;

const Num = z.number().finite();
export const DemoStateSchema = z.object({
  version: z.literal(1),
  createdAt: Num,
  cash: Num,
  deposited: Num,
  spot: z.record(z.string(), z.object({ qty: Num, avgPrice: Num })),
  positions: z.array(
    z.object({
      id: z.string(),
      coin: z.string(),
      side: z.enum(["LONG", "SHORT"]),
      leverage: Num,
      margin: Num,
      entry: Num,
      qty: Num,
      openedAt: Num,
      stop: Num.nullable(),
      takeProfit: Num.nullable(),
      liqPrice: Num,
    }),
  ),
  history: z.array(
    z.object({
      id: z.string(),
      ts: Num,
      type: z.enum(["DEPOSIT", "BUY", "SELL", "OPEN", "CLOSE", "STOP", "TAKE_PROFIT", "LIQUIDATION"]),
      coin: z.string().nullable(),
      side: z.enum(["LONG", "SHORT"]).nullable(),
      qty: Num,
      price: Num,
      amount: Num,
      fee: Num,
      pnl: Num.nullable(),
      leverage: Num.nullable(),
    }),
  ),
  equity: z.array(z.object({ ts: Num, value: Num })),
  seq: z.number().int(),
});
export type DemoState = z.infer<typeof DemoStateSchema>;
export type DemoPosition = DemoState["positions"][number];
export type DemoTrade = DemoState["history"][number];

export type DemoResult = { ok: true; state: DemoState; message: string } | { ok: false; error: string };

const round = (x: number, d = 8) => Math.round(x * 10 ** d) / 10 ** d;
const fmt = (x: number) => (Math.abs(x) >= 1000 ? x.toLocaleString("fr-FR", { maximumFractionDigits: 2 }) : Math.abs(x) >= 1 ? x.toLocaleString("fr-FR", { maximumFractionDigits: 4 }) : x.toLocaleString("fr-FR", { maximumSignificantDigits: 4 }));
const COIN = /^[A-Z0-9]{1,20}$/;

export function createDemo(now: number): DemoState {
  return { version: 1, createdAt: now, cash: 0, deposited: 0, spot: {}, positions: [], history: [], equity: [], seq: 0 };
}

/** Parse a stored state (corrupted or old data → a fresh account instead of a crash). */
export function loadDemo(raw: unknown, now: number): DemoState {
  const p = DemoStateSchema.safeParse(raw);
  return p.success ? p.data : createDemo(now);
}

const clone = (s: DemoState): DemoState => structuredClone(s);
const nextId = (s: DemoState, p: string) => `${p}${++s.seq}`;
const push = (s: DemoState, t: Omit<DemoTrade, "id">) => {
  s.history.unshift({ id: nextId(s, "t"), ...t });
  if (s.history.length > 500) s.history.length = 500;
};
/** Slippage grows a little with the order size (1 bp per 10 000 $), capped at 0.5 %. */
const slip = (notional: number) => (DEMO_FEES.slippagePct + Math.min(0.45, notional / 10_000 / 100)) / 100;

export function liqPriceOf(entry: number, leverage: number, side: "LONG" | "SHORT"): number {
  const d = 1 / leverage - DEMO_FEES.maintenancePct / 100;
  return side === "LONG" ? entry * (1 - d) : entry * (1 + d);
}

export function positionPnl(p: DemoPosition, price: number): number {
  return p.side === "LONG" ? p.qty * (price - p.entry) : p.qty * (p.entry - price);
}

export function demoDeposit(s0: DemoState, amount: number, now: number): DemoResult {
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return { ok: false, error: "montant invalide (entre 1 et 10 000 000 $)" };
  const s = clone(s0);
  s.cash = round(s.cash + amount, 2);
  s.deposited = round(s.deposited + amount, 2);
  push(s, { ts: now, type: "DEPOSIT", coin: null, side: null, qty: 0, price: 0, amount, fee: 0, pnl: null, leverage: null });
  return { ok: true, state: s, message: `${fmt(amount)} $ ajoutés au capital de démo` };
}

export function demoBuy(s0: DemoState, coin: string, usd: number, price: number, now: number): DemoResult {
  if (!COIN.test(coin)) return { ok: false, error: "crypto invalide" };
  if (!(price > 0)) return { ok: false, error: "pas de prix pour cette crypto" };
  if (!Number.isFinite(usd) || usd < 1) return { ok: false, error: "montant minimum : 1 $" };
  if (usd > s0.cash + 1e-9) return { ok: false, error: `pas assez de liquidités (${fmt(s0.cash)} $ disponibles)` };
  const s = clone(s0);
  const fill = price * (1 + slip(usd));
  const fee = (usd * DEMO_FEES.spotPct) / 100;
  const qty = (usd - fee) / fill;
  const h = s.spot[coin] ?? { qty: 0, avgPrice: 0 };
  const newQty = h.qty + qty;
  s.spot[coin] = { qty: round(newQty), avgPrice: (h.qty * h.avgPrice + qty * fill) / newQty };
  s.cash = round(s.cash - usd, 2);
  push(s, { ts: now, type: "BUY", coin, side: null, qty, price: fill, amount: usd, fee, pnl: null, leverage: null });
  return { ok: true, state: s, message: `Achat de ${fmt(qty)} ${coin} à ${fmt(fill)} $` };
}

/** Sell `fraction` (0–1] of the spot holding. */
export function demoSell(s0: DemoState, coin: string, fraction: number, price: number, now: number): DemoResult {
  const h = s0.spot[coin];
  if (!h || h.qty <= 0) return { ok: false, error: `tu ne détiens pas de ${coin}` };
  if (!(price > 0)) return { ok: false, error: "pas de prix pour cette crypto" };
  if (!(fraction > 0 && fraction <= 1)) return { ok: false, error: "part à vendre invalide" };
  const s = clone(s0);
  const qty = fraction >= 0.9999 ? h.qty : h.qty * fraction;
  const gross = qty * price;
  const fill = price * (1 - slip(gross));
  const proceeds = qty * fill;
  const fee = (proceeds * DEMO_FEES.spotPct) / 100;
  const pnl = proceeds - fee - qty * h.avgPrice;
  const left = h.qty - qty;
  if (left <= h.qty * 1e-9) delete s.spot[coin];
  else s.spot[coin] = { qty: round(left), avgPrice: h.avgPrice };
  s.cash = round(s.cash + proceeds - fee, 2);
  push(s, { ts: now, type: "SELL", coin, side: null, qty, price: fill, amount: proceeds, fee, pnl, leverage: null });
  return { ok: true, state: s, message: `Vente de ${fmt(qty)} ${coin} à ${fmt(fill)} $ (${pnl >= 0 ? "+" : ""}${fmt(pnl)} $)` };
}

export interface OpenOrder {
  coin: string;
  side: "LONG" | "SHORT";
  leverage: number;
  /** Margin put up (USD). */
  margin: number;
  price: number;
  stop?: number | null;
  takeProfit?: number | null;
  /** Highest leverage the market allows (null = unknown → demo cap). */
  maxLeverage?: number | null;
}

export function demoOpen(s0: DemoState, o: OpenOrder, now: number): DemoResult {
  if (!COIN.test(o.coin)) return { ok: false, error: "crypto invalide" };
  if (!(o.price > 0)) return { ok: false, error: "pas de prix pour cette crypto" };
  const cap = Math.min(DEMO_MAX_LEVERAGE, o.maxLeverage && o.maxLeverage > 0 ? o.maxLeverage : DEMO_MAX_LEVERAGE);
  if (!Number.isFinite(o.leverage) || o.leverage < 1 || o.leverage > cap) return { ok: false, error: `levier entre ×1 et ×${cap}` };
  if (!Number.isFinite(o.margin) || o.margin < 1) return { ok: false, error: "marge minimum : 1 $" };
  const notional = o.margin * o.leverage;
  const fee = (notional * DEMO_FEES.perpPct) / 100;
  if (o.margin + fee > s0.cash + 1e-9) return { ok: false, error: `pas assez de liquidités (marge ${fmt(o.margin)} $ + frais ${fmt(fee)} $, disponibles ${fmt(s0.cash)} $)` };
  const long = o.side === "LONG";
  const entry = o.price * (1 + (long ? 1 : -1) * slip(notional));
  const liq = liqPriceOf(entry, o.leverage, o.side);
  const stop = o.stop && o.stop > 0 ? o.stop : null;
  const tp = o.takeProfit && o.takeProfit > 0 ? o.takeProfit : null;
  if (stop !== null && (long ? stop >= entry : stop <= entry)) return { ok: false, error: `le stop doit être ${long ? "sous" : "au-dessus de"} le prix d'entrée` };
  if (tp !== null && (long ? tp <= entry : tp >= entry)) return { ok: false, error: `l'objectif doit être ${long ? "au-dessus du" : "sous le"} prix d'entrée` };
  const s = clone(s0);
  const p: DemoPosition = { id: nextId(s, "p"), coin: o.coin, side: o.side, leverage: o.leverage, margin: o.margin, entry, qty: notional / entry, openedAt: now, stop, takeProfit: tp, liqPrice: liq };
  s.positions.push(p);
  s.cash = round(s.cash - o.margin - fee, 2);
  push(s, { ts: now, type: "OPEN", coin: o.coin, side: o.side, qty: p.qty, price: entry, amount: notional, fee, pnl: null, leverage: o.leverage });
  const warn = stop !== null && (long ? stop <= liq : stop >= liq) ? " ⚠️ le stop est au-delà de la liquidation : il ne protège pas" : "";
  return { ok: true, state: s, message: `${o.side} ${o.coin} ×${o.leverage} ouvert à ${fmt(entry)} $ · liquidation à ${fmt(liq)} $${warn}` };
}

function closeAt(s: DemoState, p: DemoPosition, price: number, now: number, type: "CLOSE" | "STOP" | "TAKE_PROFIT" | "LIQUIDATION") {
  const notional = p.qty * price;
  if (type === "LIQUIDATION") {
    // The margin is lost (the maintenance margin goes to the insurance fund).
    push(s, { ts: now, type, coin: p.coin, side: p.side, qty: p.qty, price: p.liqPrice, amount: p.qty * p.liqPrice, fee: 0, pnl: -p.margin, leverage: p.leverage });
  } else {
    const fill = price * (1 + (p.side === "LONG" ? -1 : 1) * slip(notional));
    const fee = (p.qty * fill * DEMO_FEES.perpPct) / 100;
    const pnl = positionPnl(p, fill) - fee;
    s.cash = round(s.cash + Math.max(0, p.margin + pnl), 2);
    push(s, { ts: now, type, coin: p.coin, side: p.side, qty: p.qty, price: fill, amount: p.qty * fill, fee, pnl, leverage: p.leverage });
  }
  s.positions = s.positions.filter((x) => x.id !== p.id);
}

export function demoClose(s0: DemoState, id: string, price: number, now: number): DemoResult {
  const p = s0.positions.find((x) => x.id === id);
  if (!p) return { ok: false, error: "position introuvable" };
  if (!(price > 0)) return { ok: false, error: "pas de prix pour cette crypto" };
  const s = clone(s0);
  closeAt(s, p, price, now, "CLOSE");
  const t = s.history[0] as DemoTrade;
  return { ok: true, state: s, message: `${p.side} ${p.coin} fermé à ${fmt(t.price)} $ (${(t.pnl ?? 0) >= 0 ? "+" : ""}${fmt(t.pnl ?? 0)} $)` };
}

/**
 * Price update: liquidations, stops and take-profits, then an equity point (at most every 5 min).
 * Returns the new state and what happened (for notifications on the page).
 */
export function tickDemo(s0: DemoState, priceOf: (coin: string) => number | null, now: number): { state: DemoState; events: string[] } {
  const s = clone(s0);
  const events: string[] = [];
  for (const p of [...s.positions]) {
    const px = priceOf(p.coin);
    if (!(px && px > 0)) continue;
    const long = p.side === "LONG";
    if (long ? px <= p.liqPrice : px >= p.liqPrice) {
      closeAt(s, p, px, now, "LIQUIDATION");
      events.push(`💥 ${p.side} ${p.coin} ×${p.leverage} liquidé à ${fmt(p.liqPrice)} $ : −${fmt(p.margin)} $`);
    } else if (p.stop !== null && (long ? px <= p.stop : px >= p.stop)) {
      closeAt(s, p, p.stop, now, "STOP");
      events.push(`🛑 Stop touché sur ${p.side} ${p.coin} à ${fmt(p.stop)} $`);
    } else if (p.takeProfit !== null && (long ? px >= p.takeProfit : px <= p.takeProfit)) {
      closeAt(s, p, p.takeProfit, now, "TAKE_PROFIT");
      events.push(`🎯 Objectif atteint sur ${p.side} ${p.coin} à ${fmt(p.takeProfit)} $`);
    }
  }
  const v = valueDemo(s, priceOf);
  const last = s.equity[s.equity.length - 1];
  if (s.deposited > 0 && (!last || now - last.ts >= 5 * 60_000)) {
    s.equity.push({ ts: now, value: round(v.equity, 2) });
    if (s.equity.length > 3000) s.equity.splice(0, s.equity.length - 3000);
  }
  return { state: s, events };
}

export interface DemoValuation {
  equity: number;
  cash: number;
  spotValue: number;
  marginUsed: number;
  unrealized: number;
  pnl: number;
  pnlPct: number | null;
  missingPrices: string[];
  holdings: { coin: string; qty: number; avgPrice: number; price: number | null; value: number | null; pnl: number | null; pnlPct: number | null }[];
  positions: (DemoPosition & { price: number | null; pnl: number | null; pnlPct: number | null; distanceToLiqPct: number | null })[];
  stats: { trades: number; wins: number; losses: number; winRate: number | null; realized: number; fees: number; best: number | null; worst: number | null };
}

export function valueDemo(s: DemoState, priceOf: (coin: string) => number | null): DemoValuation {
  const missing: string[] = [];
  const holdings = Object.entries(s.spot).map(([coin, h]) => {
    const price = priceOf(coin);
    if (!(price && price > 0)) missing.push(coin);
    const value = price ? h.qty * price : null;
    const pnl = price ? h.qty * (price - h.avgPrice) : null;
    return { coin, qty: h.qty, avgPrice: h.avgPrice, price: price ?? null, value, pnl, pnlPct: price ? ((price - h.avgPrice) / h.avgPrice) * 100 : null };
  });
  const positions = s.positions.map((p) => {
    const price = priceOf(p.coin);
    if (!(price && price > 0)) missing.push(p.coin);
    const pnl = price ? positionPnl(p, price) : null;
    return { ...p, price: price ?? null, pnl, pnlPct: pnl !== null ? (pnl / p.margin) * 100 : null, distanceToLiqPct: price ? (Math.abs(price - p.liqPrice) / price) * 100 : null };
  });
  // Unknown price → valued at cost (spot) / entry (positions) so the total stays meaningful.
  const spotValue = holdings.reduce((a, h) => a + (h.value ?? h.qty * h.avgPrice), 0);
  const marginUsed = positions.reduce((a, p) => a + p.margin, 0);
  const unrealized = positions.reduce((a, p) => a + Math.max(-p.margin, p.pnl ?? 0), 0);
  const equity = s.cash + spotValue + marginUsed + unrealized;
  const closed = s.history.filter((t) => t.pnl !== null);
  const pnls = closed.map((t) => t.pnl as number);
  const wins = pnls.filter((x) => x > 0).length;
  return {
    equity,
    cash: s.cash,
    spotValue,
    marginUsed,
    unrealized,
    pnl: equity - s.deposited,
    pnlPct: s.deposited > 0 ? ((equity - s.deposited) / s.deposited) * 100 : null,
    missingPrices: [...new Set(missing)],
    holdings: holdings.sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
    positions,
    stats: {
      trades: closed.length,
      wins,
      losses: closed.length - wins,
      winRate: closed.length ? (wins / closed.length) * 100 : null,
      realized: pnls.reduce((a, x) => a + x, 0),
      fees: s.history.reduce((a, t) => a + t.fee, 0),
      best: pnls.length ? Math.max(...pnls) : null,
      worst: pnls.length ? Math.min(...pnls) : null,
    },
  };
}

/**
 * Portfolio accounting.
 *
 * - total      = cash + value of every holding
 * - protected  = capital the bot may never use (config)
 * - tradable   = max(0, total − protected)
 * - engaged    = market value of the open speculative positions
 * - available  = max(0, min(cash, tradable − engaged))  ← max for a new entry
 *
 * Holdings = long-term holdings ("core", e.g. BTC/ETH) + position quantities.
 * The bot only ever sells quantities that belong to one of its positions,
 * so core holdings are never sold.
 */
import type { PortfolioConfig } from "./config.js";
import type { Fill, Position } from "./types.js";

export interface PriceMark {
  price: number;
  ts: number;
}

export interface PortfolioState {
  currency: string;
  cash: number;
  /** Base currency → total quantity held. */
  holdings: Record<string, number>;
  /** Base currency → last price in the portfolio currency. */
  marks: Record<string, PriceMark>;
  initialized: boolean;
  initializedAt: number | null;
  initialValue: number;
}

export interface HoldingView {
  asset: string;
  qty: number;
  coreQty: number;
  positionQty: number;
  price: number | null;
  value: number;
  minValue: number | null;
  belowMin: boolean;
}

export interface CapitalBreakdown {
  currency: string;
  total: number;
  cash: number;
  protected: number;
  tradable: number;
  engaged: number;
  available: number;
  holdings: HoldingView[];
}

const EPS = 1e-12;

export function createPortfolio(cfg: PortfolioConfig): PortfolioState {
  return { currency: cfg.currency, cash: 0, holdings: {}, marks: {}, initialized: false, initializedAt: null, initialValue: 0 };
}

export function updateMark(state: PortfolioState, base: string, price: number, ts: number) {
  if (price > 0 && Number.isFinite(price)) state.marks[base] = { price, ts };
}

/** Assets whose price is needed before the paper portfolio can start. */
export function missingInitialMarks(state: PortfolioState, cfg: PortfolioConfig): string[] {
  return Object.entries(cfg.initial.holdings)
    .filter(([asset, value]) => value > 0 && !state.marks[asset])
    .map(([asset]) => asset);
}

/** Convert the configured initial values into quantities at the current marks. */
export function initializePortfolio(state: PortfolioState, cfg: PortfolioConfig, now: number): boolean {
  if (state.initialized || missingInitialMarks(state, cfg).length > 0) return false;
  state.cash = cfg.initial.cash;
  state.holdings = {};
  for (const [asset, value] of Object.entries(cfg.initial.holdings)) {
    if (value <= 0) continue;
    state.holdings[asset] = value / (state.marks[asset] as PriceMark).price;
  }
  state.initialized = true;
  state.initializedAt = now;
  state.initialValue = totalValue(state);
  return true;
}

export function markOf(state: PortfolioState, base: string): number | null {
  return state.marks[base]?.price ?? null;
}

export function totalValue(state: PortfolioState): number {
  let v = state.cash;
  for (const [asset, qty] of Object.entries(state.holdings)) v += qty * (markOf(state, asset) ?? 0);
  return v;
}

export function positionValue(state: PortfolioState, p: Position): number {
  return p.baseQty * (markOf(state, p.baseCurrency) ?? p.lastPrice);
}

export function capitalBreakdown(state: PortfolioState, openPositions: Position[], cfg: PortfolioConfig): CapitalBreakdown {
  const total = totalValue(state);
  const engaged = openPositions.reduce((s, p) => s + positionValue(state, p), 0);
  const tradable = Math.max(0, total - cfg.protectedCapital);
  const available = Math.max(0, Math.min(state.cash, tradable - engaged));
  const assets = new Set([...Object.keys(state.holdings), ...Object.keys(cfg.minHoldingsValue)]);
  const holdings: HoldingView[] = [...assets].sort().map((asset) => {
    const qty = state.holdings[asset] ?? 0;
    const positionQty = openPositions.filter((p) => p.baseCurrency === asset).reduce((s, p) => s + p.baseQty, 0);
    const price = markOf(state, asset);
    const value = qty * (price ?? 0);
    const minValue = cfg.minHoldingsValue[asset] ?? null;
    const coreValue = (qty - positionQty) * (price ?? 0);
    return { asset, qty, coreQty: Math.max(0, qty - positionQty), positionQty, price, value, minValue, belowMin: minValue !== null && coreValue < minValue };
  });
  return { currency: state.currency, total, cash: state.cash, protected: cfg.protectedCapital, tradable, engaged, available, holdings };
}

export function applyBuyFill(state: PortfolioState, base: string, fill: Fill) {
  state.cash -= fill.quoteGross + fill.fee;
  if (state.cash < 0 && state.cash > -1e-9) state.cash = 0;
  state.holdings[base] = (state.holdings[base] ?? 0) + fill.baseQty;
}

export function applySellFill(state: PortfolioState, base: string, fill: Fill) {
  state.cash += fill.quoteGross - fill.fee;
  const left = (state.holdings[base] ?? 0) - fill.baseQty;
  state.holdings[base] = Math.abs(left) < EPS ? 0 : left;
}

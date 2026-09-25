/**
 * Position lifecycle: opening from a fill, stop / trailing / take-profit /
 * max-duration tracking, and closing (possibly in several partial fills).
 *
 * Two distinct concepts (spec §8):
 * - stop from entry: fixed level entry × (1 − stopLoss%)
 * - trailing stop:   highest × (1 − trailing%), follows the highest price
 * The effective exit level is the higher of the two.
 */
import type { Strategy } from "./config.js";
import type { ExitReason, Fill, OrderIntent, Position, TradeRecord } from "./types.js";

export function openPosition(id: string, intent: OrderIntent, fill: Fill, strategy: Strategy, baseCurrency: string): Position {
  const entry = fill.price;
  const x = strategy.exit;
  return {
    id,
    strategyId: strategy.id,
    productId: intent.productId,
    baseCurrency,
    status: "open",
    openedAt: fill.ts,
    entryPrice: entry,
    baseQty: fill.baseQty,
    initialBaseQty: fill.baseQty,
    costQuote: fill.quoteGross + fill.fee,
    entryFees: fill.fee,
    entrySlippageQuote: fill.slippageQuote,
    entrySignalScore: intent.signalScore,
    entryReason: intent.reason,
    highestPrice: entry,
    stopLevel: entry * (1 - x.stopLossPct / 100),
    trailingLevel: x.trailingStopPct === null ? null : entry * (1 - x.trailingStopPct / 100),
    takeProfitLevel: x.takeProfitPct === null ? null : entry * (1 + x.takeProfitPct / 100),
    maxDurationSec: x.maxDurationSec,
    lastPrice: entry,
    lastPriceAt: fill.ts,
    proceedsQuote: 0,
    exitFees: 0,
    exitSlippageQuote: 0,
    exitReason: null,
    exitPrice: null,
    closedAt: null,
  };
}

/** Update last/highest price and the trailing level. */
export function markPosition(p: Position, price: number, ts: number, strategy: Strategy | undefined) {
  if (!(price > 0)) return;
  p.lastPrice = price;
  p.lastPriceAt = ts;
  if (price > p.highestPrice) {
    p.highestPrice = price;
    const t = strategy?.exit.trailingStopPct ?? null;
    if (t !== null) p.trailingLevel = price * (1 - t / 100);
  }
}

export function effectiveStop(p: Position): number {
  return Math.max(p.stopLevel, p.trailingLevel ?? Number.NEGATIVE_INFINITY);
}

/** Exit condition currently met, if any (evaluated on the last price). */
export function checkExit(p: Position, now: number): ExitReason | null {
  if (p.status !== "open") return null;
  if (p.lastPrice <= effectiveStop(p)) {
    return p.trailingLevel !== null && p.trailingLevel > p.stopLevel ? "TRAILING_STOP" : "STOP_LOSS";
  }
  if (p.takeProfitLevel !== null && p.lastPrice >= p.takeProfitLevel) return "TAKE_PROFIT";
  if (p.maxDurationSec !== null && now - p.openedAt >= p.maxDurationSec * 1000) return "MAX_DURATION";
  return null;
}

/** Entry cost attributable to the quantity still held. */
export function remainingCost(p: Position): number {
  return p.initialBaseQty > 0 ? p.costQuote * (p.baseQty / p.initialBaseQty) : 0;
}

/**
 * Unrealized P&L of the quantity still held. `exitFeePct` deducts the fee
 * that selling would cost (conservative view used by the Risk Engine).
 */
export function unrealizedPnl(p: Position, markPrice = p.lastPrice, exitFeePct = 0): number {
  return p.baseQty * markPrice * (1 - exitFeePct / 100) - remainingCost(p);
}

/** P&L already realized by partial exits. */
export function realizedPnl(p: Position): number {
  const soldQty = p.initialBaseQty - p.baseQty;
  const soldCost = p.initialBaseQty > 0 ? p.costQuote * (soldQty / p.initialBaseQty) : 0;
  return p.proceedsQuote - soldCost;
}

/**
 * Apply an exit fill. Returns true when the position is fully closed.
 * `dustThresholdBase`: a remainder below this cannot be sold (min size) and is abandoned.
 */
export function applyExitFill(p: Position, fill: Fill, reason: ExitReason, dustThresholdBase: number): boolean {
  const soldBefore = p.initialBaseQty - p.baseQty;
  p.baseQty = Math.max(0, p.baseQty - fill.baseQty);
  p.proceedsQuote += fill.quoteGross - fill.fee;
  p.exitFees += fill.fee;
  p.exitSlippageQuote += fill.slippageQuote;
  const sold = soldBefore + fill.baseQty;
  const prevWeighted = (p.exitPrice ?? 0) * soldBefore;
  p.exitPrice = (prevWeighted + fill.price * fill.baseQty) / sold;
  p.exitReason = p.exitReason ?? reason;
  if (p.baseQty <= dustThresholdBase) {
    p.status = "closed";
    p.closedAt = fill.ts;
    return true;
  }
  p.status = "open"; // partial exit: the remainder will be sold on the next evaluation
  return false;
}

export function toTradeRecord(id: string, p: Position, portfolioValueAfter: number): TradeRecord {
  const soldQty = p.initialBaseQty - p.baseQty;
  const soldCost = p.costQuote * (soldQty / p.initialBaseQty);
  const pnl = p.proceedsQuote - soldCost;
  return {
    id,
    positionId: p.id,
    strategyId: p.strategyId,
    productId: p.productId,
    openedAt: p.openedAt,
    closedAt: p.closedAt ?? p.lastPriceAt,
    entryPrice: p.entryPrice,
    exitPrice: p.exitPrice ?? p.lastPrice,
    baseQty: soldQty,
    costQuote: soldCost,
    proceedsQuote: p.proceedsQuote,
    fees: p.entryFees * (soldQty / p.initialBaseQty) + p.exitFees,
    slippageQuote: p.entrySlippageQuote + p.exitSlippageQuote,
    pnl,
    pnlPct: soldCost > 0 ? (pnl / soldCost) * 100 : 0,
    entryReason: p.entryReason,
    exitReason: p.exitReason ?? "STOP_LOSS",
    entrySignalScore: p.entrySignalScore,
    highestPrice: p.highestPrice,
    portfolioValueAfter,
  };
}

/** Paper/backtest performance statistics (spec §15). */
import type { EquityPoint, TradeRecord } from "./types.js";

export interface PerformanceStats {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  realizedPnl: number;
  unrealizedPnl: number;
  tradingPnl: number;
  avgWin: number | null;
  avgLoss: number | null;
  /** Gross profit / gross loss (null if no loss yet). */
  profitFactor: number | null;
  /** Largest peak-to-trough drop of the trading P&L curve (quote currency). */
  maxDrawdown: number;
  totalFees: number;
  totalSlippage: number;
}

export function computePerformance(trades: TradeRecord[], unrealized: number, equity: EquityPoint[]): PerformanceStats {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const realized = grossProfit - grossLoss;

  // Drawdown on the trading P&L curve (independent of BTC/ETH price moves).
  // Points: cumulative realized P&L at each close + sampled trading P&L, in time order.
  let cum = 0;
  const points = [
    ...[...trades].sort((a, b) => a.closedAt - b.closedAt).map((t) => ({ ts: t.closedAt, v: (cum += t.pnl) })),
    ...equity.map((e) => ({ ts: e.ts, v: e.tradingPnl })),
  ].sort((a, b) => a.ts - b.ts);
  let peak = 0;
  let maxDd = 0;
  for (const { v } of points) {
    peak = Math.max(peak, v);
    maxDd = Math.max(maxDd, peak - v);
  }
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : null,
    realizedPnl: realized,
    unrealizedPnl: unrealized,
    tradingPnl: realized + unrealized,
    avgWin: wins.length ? grossProfit / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    maxDrawdown: maxDd,
    totalFees: trades.reduce((s, t) => s + t.fees, 0),
    totalSlippage: trades.reduce((s, t) => s + t.slippageQuote, 0),
  };
}

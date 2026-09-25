/** Trading domain types shared by Paper (now) and Live (later). */

export type Side = "BUY" | "SELL";
export type IntentKind = "ENTRY" | "EXIT" | "ROTATION";
export type ExitReason = "STOP_LOSS" | "TRAILING_STOP" | "TAKE_PROFIT" | "MAX_DURATION";

/**
 * What a strategy (or the position manager) WANTS to do. An intent is not
 * an order: it must be approved by the Risk Engine first.
 */
export interface OrderIntent {
  id: string;
  ts: number;
  kind: IntentKind;
  productId: string;
  side: Side;
  /** BUY: amount of quote currency to spend (fees included). */
  quoteSize: number | null;
  /** SELL: quantity of base currency to sell. */
  baseSize: number | null;
  strategyId: string | null;
  positionId: string | null;
  /** Price observed when the decision was taken (last trade price). */
  referencePrice: number;
  reason: string;
  exitReason: ExitReason | null;
  signalScore: number | null;
}

export type RiskCheckName =
  | "emergency_stop"
  | "circuit_breakers"
  | "product_eligible"
  | "data_freshness"
  | "exchange_status"
  | "price_sanity"
  | "spread"
  | "liquidity"
  | "estimated_slippage"
  | "max_trade_size"
  | "min_order_size"
  | "capital_available"
  | "protected_capital"
  | "max_positions"
  | "exposure_asset"
  | "exposure_total"
  | "daily_loss"
  | "weekly_loss"
  | "trade_count"
  | "cooldown_after_loss"
  | "previous_errors"
  | "duplicate_position"
  | "position_exists";

export interface RiskCheck {
  name: RiskCheckName;
  passed: boolean;
  detail: string;
}

export interface RiskDecision {
  intentId: string;
  approved: boolean;
  checks: RiskCheck[];
  /** Details of the failed checks (empty when approved). */
  reasons: string[];
}

export type OrderStatus = "SUBMITTED" | "FILLED" | "PARTIALLY_FILLED" | "UNFILLED" | "REJECTED";

export interface Order {
  id: string;
  intent: OrderIntent;
  status: OrderStatus;
  submittedAt: number;
  completedAt: number | null;
  fill: Fill | null;
  rejectReason: string | null;
}

export interface Fill {
  orderId: string;
  ts: number;
  productId: string;
  side: Side;
  /** Price at decision time (reference for slippage). */
  requestedPrice: number;
  /** Average execution price. */
  price: number;
  baseQty: number;
  /** baseQty × price (before fees). */
  quoteGross: number;
  fee: number;
  /** Cost of the difference between requested and executed price (≥ 0 when adverse). */
  slippageQuote: number;
  slippagePct: number;
  partial: boolean;
  latencyMs: number;
}

export interface Position {
  id: string;
  strategyId: string;
  productId: string;
  baseCurrency: string;
  status: "open" | "closing" | "closed";
  openedAt: number;
  entryPrice: number;
  /** Quantity currently held for this position. */
  baseQty: number;
  initialBaseQty: number;
  /** Total quote spent at entry, fees included. */
  costQuote: number;
  entryFees: number;
  entrySlippageQuote: number;
  entrySignalScore: number | null;
  entryReason: string;
  highestPrice: number;
  /** Fixed stop from entry. */
  stopLevel: number;
  /** Trailing level following the highest price (null if disabled). */
  trailingLevel: number | null;
  takeProfitLevel: number | null;
  maxDurationSec: number | null;
  lastPrice: number;
  lastPriceAt: number;
  /** Accumulated exit results (partial exits possible). */
  proceedsQuote: number;
  exitFees: number;
  exitSlippageQuote: number;
  exitReason: ExitReason | null;
  exitPrice: number | null;
  closedAt: number | null;
}

/** A closed position, with everything the specification asks to record (§15). */
export interface TradeRecord {
  id: string;
  positionId: string;
  strategyId: string;
  productId: string;
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  baseQty: number;
  costQuote: number;
  proceedsQuote: number;
  fees: number;
  slippageQuote: number;
  pnl: number;
  pnlPct: number;
  entryReason: string;
  exitReason: ExitReason;
  entrySignalScore: number | null;
  highestPrice: number;
  /** Portfolio total value right after the close. */
  portfolioValueAfter: number;
}

export interface EquityPoint {
  ts: number;
  total: number;
  tradingPnl: number;
}

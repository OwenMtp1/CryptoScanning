/** Contract between the local API server and the dashboard. */
import type { FeedStatus } from "../market/types.js";
import type { RadarRow } from "../signals/engine.js";
import type { BreakerState } from "../trading/breakers.js";
import type { Strategy } from "../trading/config.js";
import type { PerformanceStats } from "../trading/metrics.js";
import type { CapitalBreakdown } from "../trading/portfolio.js";
import type { Order, Position } from "../trading/types.js";

export type RunMode = "RADAR" | "PAPER";

export interface FeedHealth {
  healthy: boolean;
  reason: string | null;
  lastMessageAgeMs: number | null;
  lastHeartbeatAgeMs: number | null;
}

export interface RadarSnapshot {
  /** Local time the snapshot was produced. */
  ts: number;
  /** Market time used for the evaluation (exchange clock). */
  evaluatedAt: number;
  mode: RunMode;
  health: FeedHealth;
  rows: RadarRow[];
  opportunities: number;
  signalsLast5m: number;
}

export interface StatusResponse {
  mode: RunMode;
  startedAt: number;
  feed: FeedStatus;
  health: FeedHealth;
  products: number;
  opportunities: number;
  signalsLast5m: number;
}

export interface StrategyProposal {
  strategyId: string;
  strategyName: string;
  conditions: { label: string; passed: boolean; value: number | null }[];
  allConditionsMet: boolean;
  quoteAmount: number;
  estimatedFees: number;
  risk: { approved: boolean; reasons: string[] } | null;
  action: string;
}

export interface TradingView {
  mode: RunMode;
  executionEnabled: boolean;
  initialized: boolean;
  waitingFor: string[];
  capital: CapitalBreakdown;
  initialValue: number;
  positions: (Position & { unrealizedPnl: number; effectiveStop: number; currentScore: number | null })[];
  pendingOrders: Order[];
  performance: PerformanceStats;
  breakers: BreakerState[];
  emergencyStop: BreakerState | null;
  limits: {
    lossUsed24h: number;
    maxDailyLoss: number;
    lossUsed7d: number;
    maxWeeklyLoss: number;
    entriesLastHour: number;
    maxTradesPerHour: number;
    entriesLastDay: number;
    maxTradesPerDay: number;
    openPositions: number;
    maxOpenPositions: number;
  };
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "BLOCKED";
  strategies: Strategy[];
  fees: { takerFeePct: number; assumption: string };
}


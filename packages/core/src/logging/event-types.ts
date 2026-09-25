/** Dependency-free log constants and types (safe to import in the browser). */

/**
 * Event types. The list covers the future phases (orders, positions…)
 * so the log format stays stable.
 */
export const EVENT_TYPES = [
  // System
  "SYSTEM_STARTED",
  "SYSTEM_STOPPING",
  "CONFIG_LOADED",
  "MODE_CHANGE_REJECTED",
  // Market data
  "PRODUCTS_LOADED",
  "WS_CONNECTING",
  "WS_CONNECTED",
  "WS_DISCONNECTED",
  "WS_SUBSCRIBED",
  "WS_SEQUENCE_GAP",
  "WS_DECODE_ERROR",
  "DATA_STALE",
  "DATA_RECOVERED",
  "API_ERROR",
  "SIMULATION_SCENARIO",
  // Signals
  "SIGNAL_DETECTED",
  "OPPORTUNITY_DETECTED",
  "OPPORTUNITY_EXPIRED",
  // Trading (phase 2: paper)
  "STRATEGY_TRIGGERED",
  "STRATEGY_CREATED",
  "STRATEGY_UPDATED",
  "STRATEGY_DELETED",
  "RISK_CHECK",
  "ORDER_APPROVED",
  "ORDER_REJECTED",
  "ORDER_SUBMITTED",
  "ORDER_PARTIALLY_FILLED",
  "ORDER_FILLED",
  "POSITION_OPENED",
  "POSITION_CLOSED",
  "STOP_TRIGGERED",
  "ROTATION_PLANNED",
  "ROTATION_SKIPPED",
  "BOT_PAUSED",
  "BOT_STOPPED",
  "BOT_RESUMED",
  "PAPER_INITIALIZED",
  "PAPER_RESET",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogEvent {
  id: string;
  /** ISO-8601 timestamp (local clock). */
  ts: string;
  type: EventType;
  level: LogLevel;
  message: string;
  productId?: string;
  strategy?: string;
  success?: boolean;
  data?: Record<string, unknown>;
}


/** Contract between the local API server and the dashboard. */
import type { FeedStatus } from "../market/types.js";
import type { RadarRow } from "../signals/engine.js";

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
  mode: "RADAR";
  health: FeedHealth;
  rows: RadarRow[];
  opportunities: number;
  signalsLast5m: number;
}

export interface StatusResponse {
  mode: "RADAR";
  startedAt: number;
  feed: FeedStatus;
  health: FeedHealth;
  products: number;
  opportunities: number;
  signalsLast5m: number;
}

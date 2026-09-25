/**
 * Internal signal-quality scores (0–100).
 *
 * These scores rank how strongly the current market data matches the
 * configured "bump" patterns. They are NOT a prediction of returns.
 */
import type { ProductMetrics } from "../market/state.js";
import { WINDOWS, type SignalConfig } from "./config.js";

export interface ScoreBreakdown {
  momentum: number;
  volume: number;
  acceleration: number;
  liquidity: number;
  volatility: number;
  /** Weighted average of the components. */
  composite: number;
}

export interface LiquidityAssessment {
  /** False if any liquidity gate fails: such a product must never be treated as tradable. */
  tradable: boolean;
  issues: string[];
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const logScore = (x: number | null, ref: number) =>
  x === null || x <= 0 ? 0 : 100 * clamp01(Math.log10(1 + x) / Math.log10(1 + ref));

/** Momentum: best (change / threshold) across windows. Threshold → 50, 2× threshold → 100. */
export function momentumScore(m: ProductMetrics, cfg: SignalConfig): number {
  let best = 0;
  for (const w of WINDOWS) {
    const c = m.changes[w.key];
    if (c !== null && c > 0) best = Math.max(best, c / cfg.surgeThresholdPct[w.key]);
  }
  return 100 * clamp01(best / 2);
}

/** Volume: spike ratio → 50, 2× spike ratio → 100. */
export function volumeScore(m: ProductMetrics, cfg: SignalConfig): number {
  if (m.volumeRatio === null) return 0;
  return 100 * clamp01(m.volumeRatio / (2 * cfg.volume.spikeRatio));
}

export function accelerationScore(m: ProductMetrics, cfg: SignalConfig): number {
  const last = m.segmentReturnsPct[m.segmentReturnsPct.length - 1];
  if (m.accelerationPct === null || last === undefined || last <= 0) return 0;
  return 100 * clamp01(m.accelerationPct / cfg.scoring.refs.accelerationPct);
}

export function liquidityScore(m: ProductMetrics, cfg: SignalConfig): number {
  const spread = m.spreadPct === null ? 0 : 100 * clamp01(1 - m.spreadPct / cfg.liquidity.maxSpreadPct);
  const depth = logScore(m.topBookDepthQuote, cfg.scoring.refs.topBookDepthQuote);
  const vol24 = logScore(m.volume24hQuote, cfg.scoring.refs.volume24hQuote);
  return 0.5 * spread + 0.3 * depth + 0.2 * vol24;
}

export function volatilityScore(m: ProductMetrics, cfg: SignalConfig): number {
  if (m.volatilityPct === null) return 0;
  return 100 * clamp01(m.volatilityPct / cfg.scoring.refs.volatilityPct);
}

export function scoreMetrics(m: ProductMetrics, cfg: SignalConfig): ScoreBreakdown {
  const parts = {
    momentum: momentumScore(m, cfg),
    volume: volumeScore(m, cfg),
    acceleration: accelerationScore(m, cfg),
    liquidity: liquidityScore(m, cfg),
    volatility: volatilityScore(m, cfg),
  };
  const w = cfg.scoring.weights;
  const totalW = w.momentum + w.volume + w.acceleration + w.liquidity + w.volatility;
  const composite =
    (parts.momentum * w.momentum +
      parts.volume * w.volume +
      parts.acceleration * w.acceleration +
      parts.liquidity * w.liquidity +
      parts.volatility * w.volatility) /
    totalW;
  const r = (x: number) => Math.round(x);
  return {
    momentum: r(parts.momentum),
    volume: r(parts.volume),
    acceleration: r(parts.acceleration),
    liquidity: r(parts.liquidity),
    volatility: r(parts.volatility),
    composite: r(composite),
  };
}

export function assessLiquidity(m: ProductMetrics, cfg: SignalConfig): LiquidityAssessment {
  const issues: string[] = [];
  const l = cfg.liquidity;
  if (m.spreadPct === null) issues.push("bid/ask indisponible");
  else if (m.spreadPct > l.maxSpreadPct)
    issues.push(`spread ${m.spreadPct.toFixed(2)} % > max ${l.maxSpreadPct} %`);
  if (m.topBookDepthQuote === null) issues.push("profondeur inconnue");
  else if (m.topBookDepthQuote < l.minTopBookDepthQuote)
    issues.push(`profondeur top-of-book ${Math.round(m.topBookDepthQuote)} < min ${l.minTopBookDepthQuote}`);
  if (m.volume24hQuote === null || m.volume24hQuote < l.min24hVolumeQuote)
    issues.push(`volume 24h ${m.volume24hQuote === null ? "inconnu" : Math.round(m.volume24hQuote)} < min ${l.min24hVolumeQuote}`);
  return { tradable: issues.length === 0, issues };
}

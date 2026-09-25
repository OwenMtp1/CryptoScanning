import { z } from "zod";

/** Price-change windows tracked by the radar. */
export const WINDOWS = [
  { key: "10s", sec: 10 },
  { key: "30s", sec: 30 },
  { key: "1m", sec: 60 },
  { key: "5m", sec: 300 },
] as const;
export type WindowKey = (typeof WINDOWS)[number]["key"];

const pct = z.number().positive();

export const SignalConfigSchema = z.object({
  /** Minimum % move over each window to emit a PRICE_SURGE signal. */
  surgeThresholdPct: z
    .object({ "10s": pct, "30s": pct, "1m": pct, "5m": pct })
    .default({ "10s": 0.8, "30s": 1.5, "1m": 2.5, "5m": 5 }),
  volume: z
    .object({
      /** Recent window compared to the baseline. */
      recentWindowSec: z.number().int().min(10).default(60),
      /** History used to build the baseline (excluding the recent window). */
      baselineWindowSec: z.number().int().min(60).default(1800),
      /** Minimum observed history before trusting the local baseline; before that, the 24h volume is used. */
      minBaselineHistorySec: z.number().int().min(60).default(300),
      /** recent / baseline ratio that triggers VOLUME_SPIKE. */
      spikeRatio: z.number().min(1).default(3),
    })
    .default({ recentWindowSec: 60, baselineWindowSec: 1800, minBaselineHistorySec: 300, spikeRatio: 3 }),
  acceleration: z
    .object({
      segments: z.number().int().min(3).max(12).default(4),
      segmentSec: z.number().int().min(2).default(15),
      /** Minimum (last segment − mean of previous segments), in %, to emit ACCELERATION. */
      minAccelerationPct: z.number().positive().default(0.5),
    })
    .default({ segments: 4, segmentSec: 15, minAccelerationPct: 0.5 }),
  liquidity: z
    .object({
      maxSpreadPct: z.number().positive().default(0.5),
      /** Minimum top-of-book depth (bid + ask), in quote currency. */
      minTopBookDepthQuote: z.number().nonnegative().default(1000),
      min24hVolumeQuote: z.number().nonnegative().default(50_000),
    })
    .default({ maxSpreadPct: 0.5, minTopBookDepthQuote: 1000, min24hVolumeQuote: 50_000 }),
  volatility: z
    .object({
      windowSec: z.number().int().min(30).default(300),
      stepSec: z.number().int().min(1).default(10),
    })
    .default({ windowSec: 300, stepSec: 10 }),
  scoring: z
    .object({
      weights: z
        .object({
          momentum: z.number().nonnegative(),
          volume: z.number().nonnegative(),
          acceleration: z.number().nonnegative(),
          liquidity: z.number().nonnegative(),
          volatility: z.number().nonnegative(),
        })
        .refine((w) => Object.values(w).some((v) => v > 0), "at least one weight must be > 0")
        .default({ momentum: 0.3, volume: 0.25, acceleration: 0.2, liquidity: 0.15, volatility: 0.1 }),
      /** Reference levels: a component reaches 100 at the given level. */
      refs: z
        .object({
          accelerationPct: z.number().positive(),
          topBookDepthQuote: z.number().positive(),
          volume24hQuote: z.number().positive(),
          volatilityPct: z.number().positive(),
        })
        .default({ accelerationPct: 2, topBookDepthQuote: 50_000, volume24hQuote: 10_000_000, volatilityPct: 0.5 }),
    })
    .default({
      weights: { momentum: 0.3, volume: 0.25, acceleration: 0.2, liquidity: 0.15, volatility: 0.1 },
      refs: { accelerationPct: 2, topBookDepthQuote: 50_000, volume24hQuote: 10_000_000, volatilityPct: 0.5 },
    }),
  opportunity: z
    .object({
      minScore: z.number().min(0).max(100).default(65),
      /** An opportunity expires after its score stays below minScore − hysteresis for this long. */
      expireAfterSec: z.number().int().min(1).default(30),
      hysteresis: z.number().min(0).max(50).default(10),
    })
    .default({ minScore: 65, expireAfterSec: 30, hysteresis: 10 }),
  /** Do not re-emit the same signal (product × type × window) within this delay. */
  signalCooldownSec: z.number().int().min(0).default(60),
  /** The feed is considered stale when no heartbeat/message was received for this long. */
  feedStaleAfterSec: z.number().int().min(1).default(15),
});

export type SignalConfig = z.infer<typeof SignalConfigSchema>;

export function defaultSignalConfig(): SignalConfig {
  return SignalConfigSchema.parse({});
}

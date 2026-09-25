/**
 * Trading configuration (portfolio rules, risk limits, paper simulation,
 * strategies). Validated by Zod: an invalid file prevents the server from
 * starting. Every limit here is enforced by the Risk Engine; nothing
 * (strategy, UI, AI) can bypass it.
 */
import { z } from "zod";

const pos = z.number().positive();
const nonNeg = z.number().nonnegative();
const pct = z.number().positive().max(100);

// ─── Strategies ─────────────────────────────────────────────────────────────

export const CONDITION_METRICS = [
  "priceChangePct",
  "volumeRatio",
  "score",
  "spreadPct",
  "accelerationPct",
  "liquidityScore",
] as const;
export type ConditionMetric = (typeof CONDITION_METRICS)[number];

export const ConditionSchema = z
  .object({
    metric: z.enum(CONDITION_METRICS),
    /** Required for priceChangePct. */
    window: z.enum(["10s", "30s", "1m", "5m"]).optional(),
    op: z.enum([">", ">=", "<", "<="]),
    value: z.number(),
  })
  .refine((c) => c.metric !== "priceChangePct" || c.window !== undefined, "window est obligatoire pour priceChangePct");
export type Condition = z.infer<typeof ConditionSchema>;

export const RotationSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** proceeds: the whole amount recovered at exit; profit_only: only the realized profit. */
    mode: z.enum(["proceeds", "profit_only"]).default("profit_only"),
    /** Asset → % of the amount. Sum must be ≤ 100. */
    allocations: z.record(z.string().regex(/^[A-Z0-9]+$/), pct).default({ BTC: 50, ETH: 50 }),
    /** Skip rotation orders smaller than this (quote currency). */
    minOrderQuote: pos.default(1),
  })
  .refine((r) => Object.values(r.allocations).reduce((s, x) => s + x, 0) <= 100, "la somme des allocations doit être ≤ 100 %");

export const StrategySchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  universe: z
    .object({
      quoteCurrencies: z.array(z.string()).default(["EUR"]),
      excludeBases: z.array(z.string()).default([]),
    })
    .default({ quoteCurrencies: ["EUR"], excludeBases: [] }),
  entry: z.object({ conditions: z.array(ConditionSchema).min(1) }),
  sizing: z.object({ quoteAmount: pos }),
  exit: z.object({
    /** Mandatory: a strategy without a stop loss is refused. */
    stopLossPct: pct,
    trailingStopPct: pct.nullable().default(null),
    takeProfitPct: pos.nullable().default(null),
    maxDurationSec: z.number().int().positive().nullable().default(null),
  }),
  afterExit: z
    .object({ rotation: RotationSchema.default({ enabled: false, mode: "profit_only", allocations: { BTC: 50, ETH: 50 }, minOrderQuote: 1 }) })
    .default({ rotation: { enabled: false, mode: "profit_only", allocations: { BTC: 50, ETH: 50 }, minOrderQuote: 1 } }),
  /** No new entry on the same product for this long after an entry. */
  cooldownPerProductSec: z.number().int().nonnegative().default(900),
});
export type Strategy = z.infer<typeof StrategySchema>;

/** Default strategy = the example of the specification (§20). */
export const DEFAULT_STRATEGY: z.input<typeof StrategySchema> = {
  id: "bump-momentum",
  name: "Bump momentum (exemple du cahier des charges)",
  enabled: true,
  universe: { quoteCurrencies: ["EUR"], excludeBases: [] },
  entry: {
    conditions: [
      { metric: "priceChangePct", window: "1m", op: ">", value: 3 },
      { metric: "volumeRatio", op: ">", value: 2 },
      { metric: "score", op: ">", value: 70 },
      { metric: "spreadPct", op: "<", value: 0.5 },
    ],
  },
  sizing: { quoteAmount: 10 },
  exit: { stopLossPct: 2, trailingStopPct: 2, takeProfitPct: null, maxDurationSec: 3600 },
  afterExit: { rotation: { enabled: true, mode: "profit_only", allocations: { BTC: 50, ETH: 50 }, minOrderQuote: 1 } },
  cooldownPerProductSec: 900,
};

// ─── Portfolio / risk / paper ───────────────────────────────────────────────

export const PortfolioConfigSchema = z
  .object({
    /** Accounting currency. Only products quoted in it can be traded. */
    currency: z.string().default("EUR"),
    /** Paper starting state, in currency value (converted at the first observed prices). */
    initial: z
      .object({ cash: nonNeg, holdings: z.record(z.string(), nonNeg) })
      .default({ cash: 100, holdings: { BTC: 200, ETH: 200 } }),
    /** Capital the bot can never use. */
    protectedCapital: nonNeg.default(400),
    /** Informative minimums for long-term holdings (checked, displayed). */
    minHoldingsValue: z.record(z.string(), nonNeg).default({ BTC: 200, ETH: 200 }),
  })
  .default({ currency: "EUR", initial: { cash: 100, holdings: { BTC: 200, ETH: 200 } }, protectedCapital: 400, minHoldingsValue: { BTC: 200, ETH: 200 } });
export type PortfolioConfig = z.infer<typeof PortfolioConfigSchema>;

export const RiskConfigSchema = z.object({
  maxTradeQuote: pos.default(10),
  maxOpenPositions: z.number().int().positive().default(3),
  /** Rolling 24 h loss limit (realized + unrealized of open positions). */
  maxDailyLossQuote: pos.default(5),
  /** Rolling 7 days loss limit. */
  maxWeeklyLossQuote: pos.default(15),
  maxTradesPerHour: z.number().int().positive().default(6),
  maxTradesPerDay: z.number().int().positive().default(20),
  cooldownAfterLossSec: z.number().int().nonnegative().default(300),
  maxExposurePerAssetQuote: pos.default(20),
  maxTotalExposureQuote: pos.default(50),
  maxSpreadPct: pos.default(0.5),
  minTopBookDepthQuote: nonNeg.default(1000),
  min24hVolumeQuote: nonNeg.default(50_000),
  /** Market data older than this blocks entries. */
  maxDataAgeSec: pos.default(10),
  /** Exits need a price at most this old. */
  maxExitDataAgeSec: pos.default(60),
  /** Reference price must be within this % of the current mid. */
  maxPriceDeviationPct: pos.default(2),
  /** Estimated slippage (from order size vs top-of-book) above this blocks the order. */
  maxEstimatedSlippagePct: pos.default(1),
  /** A realized slippage above this trips a circuit breaker. */
  maxRealizedSlippagePct: pos.default(2),
  maxConsecutiveErrors: z.number().int().positive().default(3),
  /** Execution-level rejections (unfilled / refused orders) per hour before tripping. */
  maxExecutionRejectionsPerHour: z.number().int().positive().default(10),
  /** Minimum delay before re-proposing a rejected trigger for the same strategy × product. */
  retryAfterRejectSec: z.number().int().nonnegative().default(60),
});
export type RiskConfig = z.infer<typeof RiskConfigSchema>;

export const PaperConfigSchema = z.object({
  /**
   * Taker fee in %. PRUDENT ASSUMPTION, NOT VERIFIED against the current
   * Coinbase schedule (docs unreachable from the dev environment): check
   * your tier in Coinbase Advanced → Fees and adjust.
   */
  takerFeePct: nonNeg.default(1.2),
  latencyMs: z.tuple([nonNeg, nonNeg]).default([150, 600]),
  /** Random slippage component, in basis points (0 → this value). */
  baseSlippageBps: nonNeg.default(2),
  /** Extra slippage in % for an order equal to the top-of-book depth. */
  impactPctPerDepth: nonNeg.default(0.3),
  /** Orders larger than this multiple of the top-of-book depth are partially filled. */
  maxDepthMultiple: pos.default(3),
  /** Probability that a market order finds no liquidity (simulated failure). */
  unfilledProbability: z.number().min(0).max(1).default(0.01),
  seed: z.number().int().default(7),
});
export type PaperConfig = z.infer<typeof PaperConfigSchema>;

export const TradingConfigSchema = z
  .object({
    portfolio: PortfolioConfigSchema,
    risk: RiskConfigSchema.default(RiskConfigSchema.parse({})),
    paper: PaperConfigSchema.default(PaperConfigSchema.parse({})),
    strategies: z.array(StrategySchema).default([StrategySchema.parse(DEFAULT_STRATEGY)]),
    equitySampleSec: z.number().int().min(5).default(60),
  })
  .refine((c) => new Set(c.strategies.map((s) => s.id)).size === c.strategies.length, "identifiants de stratégie en double")
  .refine((c) => c.strategies.every((s) => s.sizing.quoteAmount <= c.risk.maxTradeQuote), {
    message: "une stratégie demande un montant supérieur à risk.maxTradeQuote",
  });
export type TradingConfig = z.infer<typeof TradingConfigSchema>;

/** Rules a strategy must respect with respect to the risk limits (checked on save and at startup). */
export function strategyRiskIssues(strategy: Strategy, risk: RiskConfig): string[] {
  const issues: string[] = [];
  if (strategy.sizing.quoteAmount > risk.maxTradeQuote)
    issues.push(`montant ${strategy.sizing.quoteAmount} > maximum par trade du Risk Engine (${risk.maxTradeQuote})`);
  return issues;
}

/** File written by the Strategy Builder (data/strategies.json). */
export const StrategiesFileSchema = z.object({
  version: z.literal(1),
  savedAt: z.string(),
  strategies: z.array(StrategySchema),
});

export function defaultTradingConfig(): TradingConfig {
  return TradingConfigSchema.parse({});
}

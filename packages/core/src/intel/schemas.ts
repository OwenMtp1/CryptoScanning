/**
 * Zod schemas for the intelligence sources. Field names come from the
 * official documentation of each provider:
 * - Binance: github.com/binance/binance-spot-api-docs (web-socket-streams.md,
 *   rest-api.md). Note: `!ticker@arr` was retired on 2026-03-26; the radar
 *   uses `!miniTicker@arr` and `!ticker_1h@arr`.
 * - CoinGecko / GeckoTerminal: github.com/coingecko/coingecko-api-oas (demo-api.json).
 */
import { z } from "zod";

const num = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: "custom", message: `not a number: ${String(v)}` });
    return z.NEVER;
  }
  return n;
});
const optNum = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  });

// ─── Binance ────────────────────────────────────────────────────────────────

/** `<symbol>@miniTicker` payload (items of `!miniTicker@arr`). */
export const BinanceMiniTickerSchema = z.object({
  e: z.literal("24hrMiniTicker"),
  E: z.number(),
  s: z.string(),
  c: num,
  o: num,
  h: num,
  l: num,
  v: num,
  q: num,
});
export type BinanceMiniTicker = z.infer<typeof BinanceMiniTickerSchema>;

/** `<symbol>@ticker_1h` payload (items of `!ticker_1h@arr`). */
export const BinanceWindowTickerSchema = z.object({
  e: z.string(),
  E: z.number(),
  s: z.string(),
  P: num,
  c: num,
  q: num,
  n: z.number().optional(),
});
export type BinanceWindowTicker = z.infer<typeof BinanceWindowTickerSchema>;

export const BinanceExchangeInfoSchema = z.object({
  symbols: z.array(
    z.object({
      symbol: z.string(),
      status: z.string(),
      baseAsset: z.string(),
      quoteAsset: z.string(),
      isSpotTradingAllowed: z.boolean().optional(),
    }),
  ),
});

// ─── CoinGecko ──────────────────────────────────────────────────────────────

/** Row of `GET /coins/markets` (with price_change_percentage=1h,24h,7d). */
export const CgMarketRowSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  current_price: optNum,
  market_cap: optNum,
  market_cap_rank: optNum,
  total_volume: optNum,
  high_24h: optNum,
  low_24h: optNum,
  price_change_percentage_24h: optNum,
  ath: optNum,
  ath_change_percentage: optNum,
  price_change_percentage_1h_in_currency: optNum,
  price_change_percentage_24h_in_currency: optNum,
  price_change_percentage_7d_in_currency: optNum,
  last_updated: z.string().nullable().optional(),
});
export type CgMarketRow = z.infer<typeof CgMarketRowSchema>;

/** `GET /search/trending`. */
export const CgTrendingSchema = z.object({
  coins: z
    .array(
      z.object({
        item: z.object({
          id: z.string(),
          name: z.string(),
          symbol: z.string(),
          market_cap_rank: optNum,
          score: z.number().optional(),
        }),
      }),
    )
    .default([]),
});

/** Item of `GET /derivatives`. */
export const CgDerivativeSchema = z.object({
  market: z.string(),
  symbol: z.string(),
  index_id: z.string().nullable().optional(),
  price: optNum,
  price_percentage_change_24h: optNum,
  contract_type: z.string().nullable().optional(),
  funding_rate: optNum,
  open_interest: optNum,
  volume_24h: optNum,
});
export type CgDerivative = z.infer<typeof CgDerivativeSchema>;

const windows = ["m5", "m15", "m30", "h1", "h6", "h24"] as const;
const byWindow = <T extends z.ZodTypeAny>(t: T) => z.object(Object.fromEntries(windows.map((w) => [w, t.optional()])) as Record<(typeof windows)[number], z.ZodOptional<T>>).partial().default({});

/** `GET /onchain/networks/trending_pools` and `/onchain/networks/new_pools` (include=base_token). */
export const GtPoolsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      attributes: z.object({
        name: z.string(),
        address: z.string(),
        pool_created_at: z.string().nullable().optional(),
        base_token_price_usd: optNum,
        fdv_usd: optNum,
        market_cap_usd: optNum,
        reserve_in_usd: optNum,
        price_change_percentage: byWindow(optNum),
        volume_usd: byWindow(optNum),
        transactions: byWindow(z.object({ buys: z.number().optional(), sells: z.number().optional(), buyers: z.number().optional(), sellers: z.number().optional() })),
        community_sus_report: z.number().nullable().optional(),
      }),
      relationships: z
        .object({
          base_token: z.object({ data: z.object({ id: z.string() }).nullable().optional() }).optional(),
          network: z.object({ data: z.object({ id: z.string() }).nullable().optional() }).optional(),
          dex: z.object({ data: z.object({ id: z.string() }).nullable().optional() }).optional(),
        })
        .optional(),
    }),
  ),
  included: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        attributes: z.object({ name: z.string().optional(), symbol: z.string().optional(), coingecko_coin_id: z.string().nullable().optional() }).partial(),
      }),
    )
    .optional(),
});
export type GtPools = z.infer<typeof GtPoolsSchema>;

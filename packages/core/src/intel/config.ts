import { z } from "zod";

const pct = z.number().positive();
const nonNeg = z.number().nonnegative();

/** Configuration of the multi-source intelligence layer (all thresholds tunable). */
export const IntelConfigSchema = z.object({
  binance: z
    .object({
      enabled: z.boolean().default(true),
      /** Quote assets used to track coins on Binance (the first found wins per coin). */
      quotes: z.array(z.string()).default(["USDT", "USDC", "FDUSD"]),
      pumpPct5m: pct.default(4),
      pumpPct15m: pct.default(7),
      dumpPct5m: pct.default(5),
      dumpPct15m: pct.default(9),
      /** 1 h quote volume / average hourly volume over 24 h. */
      volumeSurgeRatio: pct.default(4),
      /** Ignore pairs with less 24 h quote volume than this (USD). */
      minVolume24hUsd: nonNeg.default(200_000),
    })
    .prefault({}),
  coingecko: z
    .object({
      enabled: z.boolean().default(true),
      /** Monthly call budget of the plan (Demo: 10 000). */
      monthlyCallBudget: z.number().int().positive().default(10_000),
      maxCallsPerMinute: z.number().int().positive().default(30),
      /** Number of coins (by market cap) refreshed through /coins/markets (250 per call). */
      universeSize: z.number().int().min(250).max(20_000).default(1000),
      minMarketCapUsd: nonNeg.default(1_000_000),
      moverPct1h: pct.default(8),
      crashPct1h: pct.default(10),
      /** 24 h volume / market cap ratio considered anomalous. */
      volumeMcapRatio: pct.default(0.6),
      nearAthPct: pct.default(3),
      fundingExtremePct: pct.default(0.05),
      openInterestSurgePct: pct.default(15),
      dex: z
        .object({
          enabled: z.boolean().default(true),
          minReserveUsd: nonNeg.default(30_000),
          minVolume1hUsd: nonNeg.default(50_000),
          minBuySellRatio: pct.default(1.5),
          pumpPct1h: pct.default(25),
          rugDropPct1h: pct.default(40),
          maxPoolAgeHours: pct.default(48),
        })
        .prefault({}),
    })
    .prefault({}),
  news: z
    .object({
      enabled: z.boolean().default(true),
      intervalSec: z.number().int().min(60).default(300),
      feeds: z
        .array(z.object({ name: z.string(), url: z.url(), lang: z.enum(["en", "fr"]).default("en") }))
        .default([
          { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", lang: "en" },
          { name: "Cointelegraph", url: "https://cointelegraph.com/rss", lang: "en" },
          { name: "Decrypt", url: "https://decrypt.co/feed", lang: "en" },
          { name: "The Block", url: "https://www.theblock.co/rss.xml", lang: "en" },
          { name: "Bitcoin Magazine", url: "https://bitcoinmagazine.com/.rss/full/", lang: "en" },
          { name: "CryptoSlate", url: "https://cryptoslate.com/feed/", lang: "en" },
          { name: "Cryptoast", url: "https://cryptoast.fr/feed/", lang: "fr" },
          { name: "Journal du Coin", url: "https://journalducoin.com/feed/", lang: "fr" },
        ]),
    })
    .prefault({}),
  confluence: z
    .object({
      windowMin: z.number().int().positive().default(120),
      minSources: z.number().int().min(2).default(2),
    })
    .prefault({}),
  tracking: z
    .object({
      horizonsMin: z.array(z.number().int().positive()).default([15, 60, 240, 1440]),
      /** A signal is a "hit" when price moved at least this much in its direction. */
      hitThresholdPct: pct.default(2),
      maxTracked: z.number().int().positive().default(20_000),
    })
    .prefault({}),
  /** Same coin × kind is not re-emitted within this delay. */
  cooldownMin: z.number().int().nonnegative().default(60),
  discord: z
    .object({
      enabled: z.boolean().default(true),
      minStrength: z.number().min(0).max(100).default(70),
      /** Only these kinds are sent (empty = all). */
      kinds: z.array(z.string()).default([]),
      directions: z.array(z.enum(["bullish", "bearish", "neutral"])).default(["bullish", "bearish"]),
      /** Same coin is not re-alerted within this delay. */
      perCoinCooldownMin: z.number().int().nonnegative().default(60),
      /** Low-priority signals are grouped into one digest message every N minutes (0 = off). */
      digestMin: z.number().int().nonnegative().default(15),
      maxMessagesPerHour: z.number().int().positive().default(30),
      /** Discord role id to mention for strength ≥ mentionMinStrength (null = never mention). */
      mentionRoleId: z.string().regex(/^\d+$/).nullable().default(null),
      mentionMinStrength: z.number().min(0).max(100).default(90),
      includeNews: z.boolean().default(true),
      /** One Discord message per signal (instead of up to 10 signals grouped in one message). */
      onePerMessage: z.boolean().default(false),
    })
    .prefault({}),
});
export type IntelConfig = z.infer<typeof IntelConfigSchema>;

export function defaultIntelConfig(): IntelConfig {
  return IntelConfigSchema.parse({});
}

/**
 * Candles for charts and trader setups: Binance spot klines first (widest coverage, 1000 bars),
 * Coinbase Advanced public candles as fallback (Binance blocked, or a coin only on Coinbase).
 * Transport-agnostic: the caller supplies `get(url) → body text` (browser fetch, Worker fetch…).
 */
import { aggregateCandles, parseBinanceKlines, parseCoinbaseCandles, type Candle } from "@radar/core";

export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

const MS: Record<CandleInterval, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
/** Coinbase granularity (and grouping factor when it has no native equivalent). */
const CB: Record<CandleInterval, [string, number]> = {
  "1m": ["ONE_MINUTE", 1],
  "5m": ["FIVE_MINUTE", 1],
  "15m": ["FIFTEEN_MINUTE", 1],
  "1h": ["ONE_HOUR", 1],
  "4h": ["ONE_HOUR", 4],
  "1d": ["ONE_DAY", 1],
};

export const binanceKlinesUrl = (coin: string, interval: CandleInterval, limit: number, quote = "USDT", base = "https://data-api.binance.vision") =>
  `${base}/api/v3/klines?symbol=${encodeURIComponent(coin.toUpperCase() + quote)}&interval=${interval}&limit=${Math.min(1000, Math.max(1, limit))}`;

export function coinbaseCandlesUrl(coin: string, interval: CandleInterval, limit: number, now = Date.now()) {
  const [gran, group] = CB[interval];
  const n = Math.min(350, limit * group);
  const step = MS[interval] / group;
  const end = Math.floor(now / 1000);
  const start = Math.floor((now - n * step) / 1000);
  return `https://api.coinbase.com/api/v3/brokerage/market/products/${encodeURIComponent(coin.toUpperCase())}-USD/candles?start=${start}&end=${end}&granularity=${gran}&limit=${n}`;
}

export interface CandleResult {
  candles: Candle[];
  source: "Binance" | "Coinbase";
  pair: string;
}

/** Load `limit` candles of `coin` (USD quoted), newest last. Throws when no source has the coin. */
export async function loadCandles(get: (url: string) => Promise<string>, coin: string, interval: CandleInterval, limit: number, opts: { skipBinance?: boolean; now?: number; binanceBase?: string } = {}): Promise<CandleResult> {
  const errors: string[] = [];
  const c = coin.toUpperCase();
  if (!opts.skipBinance) {
    for (const quote of c === "USDT" ? ["USDC"] : ["USDT", "USDC"]) {
      try {
        const cs = parseBinanceKlines(JSON.parse(await get(binanceKlinesUrl(c, interval, limit, quote, opts.binanceBase))));
        if (cs.length >= Math.min(30, limit)) return { candles: cs, source: "Binance", pair: `${c}/${quote}` };
        errors.push(`Binance ${c}${quote} : trop peu de données`);
      } catch (e) {
        errors.push(`Binance ${c}${quote} : ${(e as Error).message}`);
        // Only an unknown symbol (HTTP 400) is worth retrying with the other quote.
        if (!/400/.test((e as Error).message)) break;
      }
    }
  }
  try {
    const [, group] = CB[interval];
    let cs = parseCoinbaseCandles(JSON.parse(await get(coinbaseCandlesUrl(c, interval, limit, opts.now))));
    if (group > 1) cs = aggregateCandles(cs, group);
    if (cs.length) return { candles: cs.slice(-limit), source: "Coinbase", pair: `${c}-USD` };
    errors.push(`Coinbase ${c}-USD : aucune bougie`);
  } catch (e) {
    errors.push(`Coinbase ${c}-USD : ${(e as Error).message}`);
  }
  throw new Error(errors.join(" · "));
}

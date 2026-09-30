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
  source: string;
  pair: string;
}

/** Other exchanges, read through the site's `/api/candles` function (fixed whitelist, shared cache). */
export const EXTRA_CANDLE_EXCHANGES = ["okx", "bybit", "kucoin", "mexc", "gate"] as const;
export type ExtraCandleExchange = (typeof EXTRA_CANDLE_EXCHANGES)[number];
export const EXTRA_CANDLE_NAME: Record<ExtraCandleExchange, string> = { okx: "OKX", bybit: "Bybit", kucoin: "KuCoin", mexc: "MEXC", gate: "Gate.io" };

const num = (x: unknown) => Number(x);
const valid = (c: Candle) => [c.t, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite) && c.c > 0;

/** Parse one exchange's candle answer (each has its own column order), oldest first. */
export function parseExchangeCandles(ex: ExtraCandleExchange, json: unknown): Candle[] {
  let rows: unknown[] = [];
  let map: (r: unknown[]) => Candle;
  switch (ex) {
    case "okx": // { data: [[ts ms, o, h, l, c, vol, …]] } newest first
      rows = ((json as { data?: unknown[] })?.data ?? []) as unknown[];
      map = (r) => ({ t: num(r[0]), o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]), v: num(r[5]) });
      break;
    case "bybit": // { result: { list: [[start ms, o, h, l, c, vol, turnover]] } } newest first
      rows = ((json as { result?: { list?: unknown[] } })?.result?.list ?? []) as unknown[];
      map = (r) => ({ t: num(r[0]), o: num(r[1]), h: num(r[2]), l: num(r[3]), c: num(r[4]), v: num(r[5]) });
      break;
    case "kucoin": // { data: [[time s, open, close, high, low, volume, turnover]] } newest first
      rows = ((json as { data?: unknown[] })?.data ?? []) as unknown[];
      map = (r) => ({ t: num(r[0]) * 1000, o: num(r[1]), c: num(r[2]), h: num(r[3]), l: num(r[4]), v: num(r[5]) });
      break;
    case "mexc": // Binance format
      return parseBinanceKlines(json);
    case "gate": // [[t s, quote vol, close, high, low, open, base vol, closed]] oldest first
      rows = Array.isArray(json) ? json : [];
      map = (r) => ({ t: num(r[0]) * 1000, c: num(r[2]), h: num(r[3]), l: num(r[4]), o: num(r[5]), v: num(r[6]) });
      break;
  }
  return rows
    .filter((r): r is unknown[] => Array.isArray(r) && r.length >= 6)
    .map(map)
    .filter(valid)
    .sort((a, b) => a.t - b.t);
}

/** Load `limit` candles of `coin` (USD quoted), newest last. Throws when no source has the coin. */
export async function loadCandles(get: (url: string) => Promise<string>, coin: string, interval: CandleInterval, limit: number, opts: { skipBinance?: boolean; now?: number; binanceBase?: string; extraBase?: string; only?: string } = {}): Promise<CandleResult> {
  const errors: string[] = [];
  const c = coin.toUpperCase();
  const only = opts.only && opts.only !== "auto" ? opts.only : null;
  if (!opts.skipBinance && (!only || only === "binance")) {
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
  if (!only || only === "coinbase") {
    try {
      const [, group] = CB[interval];
      let cs = parseCoinbaseCandles(JSON.parse(await get(coinbaseCandlesUrl(c, interval, limit, opts.now))));
      if (group > 1) cs = aggregateCandles(cs, group);
      if (cs.length) return { candles: cs.slice(-limit), source: "Coinbase", pair: `${c}-USD` };
      errors.push(`Coinbase ${c}-USD : aucune bougie`);
    } catch (e) {
      errors.push(`Coinbase ${c}-USD : ${(e as Error).message}`);
    }
  }
  // Then the other exchanges (through the site): OKX, Bybit, KuCoin, MEXC, Gate.io.
  if (opts.extraBase !== undefined) {
    for (const ex of EXTRA_CANDLE_EXCHANGES) {
      if (only && only !== ex) continue;
      try {
        const cs = parseExchangeCandles(ex, JSON.parse(await get(`${opts.extraBase}/api/candles?ex=${ex}&coin=${encodeURIComponent(c)}&interval=${interval}&limit=${Math.max(10, Math.min(1000, limit))}`)));
        if (cs.length >= Math.min(20, limit)) return { candles: cs.slice(-limit), source: EXTRA_CANDLE_NAME[ex], pair: `${c}/USDT` };
        errors.push(`${EXTRA_CANDLE_NAME[ex]} : ${cs.length ? "trop peu de données" : "crypto absente"}`);
      } catch (e) {
        errors.push(`${EXTRA_CANDLE_NAME[ex]} : ${(e as Error).message}`);
      }
    }
  }
  throw new Error(errors.join(" · "));
}

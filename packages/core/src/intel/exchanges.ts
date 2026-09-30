/**
 * All-market tickers of other centralised exchanges, normalised to the
 * Binance MINI ticker shape (symbol = BASE + USDT) so the same history and
 * detectors apply. Public endpoints, no key:
 *   OKX    GET https://www.okx.com/api/v5/market/tickers?instType=SPOT
 *          → { data: [{ instId: "BTC-USDT", last, open24h, high24h, low24h, volCcy24h, ts }] }
 *   KuCoin GET https://api.kucoin.com/api/v1/market/allTickers
 *          → { data: { time, ticker: [{ symbol: "BTC-USDT", last, high, low, volValue, changeRate }] } }
 *   MEXC   GET https://api.mexc.com/api/v3/ticker/24hr (Binance-compatible fields)
 * Field names are those publicly documented by each exchange; anything that
 * does not parse is skipped.
 */
import type { BinanceMiniRestTicker } from "./schemas.js";

export type ExchangeId = "okx" | "kucoin" | "mexc";

export const EXCHANGE_TICKER_URLS: Record<ExchangeId, string> = {
  okx: "https://www.okx.com/api/v5/market/tickers?instType=SPOT",
  kucoin: "https://api.kucoin.com/api/v1/market/allTickers",
  mexc: "https://api.mexc.com/api/v3/ticker/24hr",
};

export const EXCHANGE_NAME: Record<ExchangeId, string> = { okx: "OKX", kucoin: "KuCoin", mexc: "MEXC" };

export function exchangeTradeUrl(ex: ExchangeId, coin: string): string {
  if (ex === "okx") return `https://www.okx.com/trade-spot/${coin.toLowerCase()}-usdt`;
  if (ex === "kucoin") return `https://www.kucoin.com/trade/${coin}-USDT`;
  return `https://www.mexc.com/exchange/${coin}_USDT`;
}

const n = (v: unknown) => {
  const x = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(x) ? null : x;
};

function make(coin: string, last: number | null, open: number | null, high: number | null, low: number | null, quoteVol: number | null, now: number): BinanceMiniRestTicker | null {
  if (!coin || last === null || !(last > 0)) return null;
  return { symbol: `${coin.toUpperCase()}USDT`, openPrice: open ?? last, highPrice: high ?? last, lowPrice: low ?? last, lastPrice: last, quoteVolume: quoteVol ?? 0, closeTime: now };
}

export function parseExchangeTickers(ex: ExchangeId, json: unknown, now: number): BinanceMiniRestTicker[] {
  const out: BinanceMiniRestTicker[] = [];
  const push = (t: BinanceMiniRestTicker | null) => t && out.push(t);
  if (ex === "okx") {
    for (const r of ((json as { data?: unknown[] })?.data ?? []) as Record<string, unknown>[]) {
      const id = String(r.instId ?? "");
      if (!id.endsWith("-USDT")) continue;
      push(make(id.slice(0, -5), n(r.last), n(r.open24h), n(r.high24h), n(r.low24h), n(r.volCcy24h), now));
    }
  } else if (ex === "kucoin") {
    for (const r of ((json as { data?: { ticker?: unknown[] } })?.data?.ticker ?? []) as Record<string, unknown>[]) {
      const id = String(r.symbol ?? "");
      if (!id.endsWith("-USDT")) continue;
      const last = n(r.last);
      const rate = n(r.changeRate);
      push(make(id.slice(0, -5), last, last !== null && rate !== null ? last / (1 + rate) : null, n(r.high), n(r.low), n(r.volValue), now));
    }
  } else {
    for (const r of (Array.isArray(json) ? json : []) as Record<string, unknown>[]) {
      const id = String(r.symbol ?? "");
      if (!id.endsWith("USDT") || id.length <= 4) continue;
      push(make(id.slice(0, -4), n(r.lastPrice), n(r.openPrice), n(r.highPrice), n(r.lowPrice), n(r.quoteVolume), now));
    }
  }
  return out;
}

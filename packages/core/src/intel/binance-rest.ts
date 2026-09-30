/**
 * Binance all-market snapshots from REST (`GET /api/v3/ticker/24hr?type=MINI`,
 * weight 80, all symbols) — for a scheduled worker that cannot keep a
 * WebSocket open. ~20 min of samples give the 5 / 15 min changes; the 24 h
 * high / low come with the ticker (breakouts work too).
 */
import type { LiveSnapshot } from "./detectors.js";
import type { BinanceMiniRestTicker } from "./schemas.js";

const KEEP_MS = 20 * 60_000;

export type BinanceHistoryState = Record<string, [number, number][]>;

export class BinanceRestHistory {
  private readonly hist = new Map<string, [number, number][]>();

  constructor(
    private readonly quotes: string[],
    state: BinanceHistoryState | null = null,
    private readonly minSpacingMs = 50_000,
  ) {
    for (const [k, v] of Object.entries(state ?? {})) if (Array.isArray(v)) this.hist.set(k, v.slice(-40));
  }

  /** One pair per coin, by quote priority (USDT, USDC, FDUSD…); stale symbols skipped. */
  pick(tickers: BinanceMiniRestTicker[], now: number): { coin: string; t: BinanceMiniRestTicker }[] {
    const byCoin = new Map<string, { coin: string; t: BinanceMiniRestTicker; rank: number }>();
    const quotes = [...this.quotes].sort((a, b) => b.length - a.length);
    for (const t of tickers) {
      if (now - t.closeTime > 10 * 60_000 || !(t.lastPrice > 0)) continue;
      const q = quotes.find((x) => t.symbol.endsWith(x) && t.symbol.length > x.length);
      if (!q) continue;
      const coin = t.symbol.slice(0, -q.length);
      const rank = this.quotes.indexOf(q);
      const cur = byCoin.get(coin);
      if (!cur || rank < cur.rank) byCoin.set(coin, { coin, t, rank });
    }
    return [...byCoin.values()];
  }

  update(tickers: BinanceMiniRestTicker[], now: number): LiveSnapshot[] {
    const out: LiveSnapshot[] = [];
    for (const { coin, t } of this.pick(tickers, now)) {
      const price = t.lastPrice;
      const h = this.hist.get(coin) ?? [];
      const ago = (min: number) => {
        let best: [number, number] | null = null;
        for (const s of h) {
          const age = (now - s[0]) / 60_000;
          if (age >= min * 0.6 && age <= min * 1.4 && (!best || Math.abs(age - min) < Math.abs((now - best[0]) / 60_000 - min))) best = s;
        }
        return best && best[1] > 0 ? ((price - best[1]) / best[1]) * 100 : null;
      };
      out.push({ coin, pair: t.symbol, priceUsd: price, change5m: ago(5), change15m: ago(15), change1h: null, volumeRatio1h: null, volume24hUsd: t.quoteVolume, high24h: t.highPrice, low24h: t.lowPrice });
      const last = h[h.length - 1];
      if (!last || now - last[0] >= this.minSpacingMs) h.push([now, price]);
      while (h.length && (h[0] as [number, number])[0] < now - KEEP_MS) h.shift();
      this.hist.set(coin, h);
    }
    return out;
  }

  export(): BinanceHistoryState {
    return Object.fromEntries(this.hist);
  }
}

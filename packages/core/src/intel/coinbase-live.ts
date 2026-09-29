/**
 * Coinbase price history from periodic snapshots of the public product list
 * (`GET /api/v3/brokerage/market/products`, which carries price, 24 h change
 * and 24 h volume). Keeping ~20 min of samples gives the 5 / 15 min changes
 * without a WebSocket — usable from a browser poll or a scheduled worker.
 */
import type { Product } from "../market/types.js";
import type { LiveSnapshot } from "./detectors.js";

const USD_QUOTES = ["USD", "USDC"];
const KEEP_MS = 20 * 60_000;

export type CoinbaseHistoryState = Record<string, [number, number][]>;

export class CoinbasePriceHistory {
  private readonly hist = new Map<string, [number, number][]>();

  constructor(
    state: CoinbaseHistoryState | null = null,
    /** Minimum spacing between stored samples (keeps the state small with frequent polls). */
    private readonly minSpacingMs = 50_000,
  ) {
    for (const [k, v] of Object.entries(state ?? {})) if (Array.isArray(v)) this.hist.set(k, v.slice(-40));
  }

  /** One USD-like product per coin: USD first, then USDC; tradable and priced only. */
  static pick(products: Product[]): Product[] {
    const byCoin = new Map<string, Product>();
    for (const q of USD_QUOTES)
      for (const p of products) {
        if (p.quoteCurrency !== q || byCoin.has(p.baseCurrency)) continue;
        if (p.status !== "online" || p.flags.tradingDisabled || p.flags.isDisabled || p.flags.viewOnly || p.flags.cancelOnly) continue;
        if (!(p.price !== null && p.price > 0)) continue;
        byCoin.set(p.baseCurrency, p);
      }
    return [...byCoin.values()];
  }

  /** Record a snapshot and return live snapshots (changes are null until enough history exists). */
  update(products: Product[], now: number): LiveSnapshot[] {
    const out: LiveSnapshot[] = [];
    for (const p of CoinbasePriceHistory.pick(products)) {
      const price = p.price as number;
      const h = this.hist.get(p.baseCurrency) ?? [];
      const ago = (min: number) => {
        // Sample closest to `min` minutes ago, accepted within ±40 %.
        let best: [number, number] | null = null;
        for (const s of h) {
          const age = (now - s[0]) / 60_000;
          if (age >= min * 0.6 && age <= min * 1.4 && (!best || Math.abs(age - min) < Math.abs((now - best[0]) / 60_000 - min))) best = s;
        }
        return best && best[1] > 0 ? ((price - best[1]) / best[1]) * 100 : null;
      };
      out.push({
        coin: p.baseCurrency,
        pair: p.productId,
        priceUsd: price,
        change5m: ago(5),
        change15m: ago(15),
        change1h: null,
        volumeRatio1h: null,
        volume24hUsd: p.volume24hQuote ?? 0,
        // The product list has no 24 h range: breakout detectors stay silent.
        high24h: price,
        low24h: price,
      });
      const last = h[h.length - 1];
      if (!last || now - last[0] >= this.minSpacingMs) h.push([now, price]);
      while (h.length && (h[0] as [number, number])[0] < now - KEEP_MS) h.shift();
      this.hist.set(p.baseCurrency, h);
    }
    return out;
  }

  export(): CoinbaseHistoryState {
    return Object.fromEntries(this.hist);
  }
}

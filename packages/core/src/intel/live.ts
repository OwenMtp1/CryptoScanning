/**
 * Live all-market tracker for Binance (`!miniTicker@arr` + `!ticker_1h@arr`):
 * keeps a short price history per pair and builds LiveSnapshots.
 * Stablecoin quotes (USDT, USDC, FDUSD) are treated as USD.
 */
import { SecondSeries } from "../market/series.js";
import type { LiveSnapshot } from "./detectors.js";
import type { BinanceMiniTicker, BinanceWindowTicker } from "./schemas.js";

interface PairState {
  coin: string;
  pair: string;
  series: SecondSeries;
  firstAt: number;
  mini: BinanceMiniTicker | null;
  window1h: BinanceWindowTicker | null;
}

export class LiveTracker {
  private readonly pairs = new Map<string, PairState>();
  /** coin → chosen pair (first quote in priority order). */
  private readonly coinPair = new Map<string, string>();

  constructor(
    /** pair symbol → { base, quote } from exchangeInfo */
    private readonly symbols: Map<string, { base: string; quote: string }>,
    private readonly quotes: string[],
  ) {
    for (const q of quotes)
      for (const [pair, s] of symbols) if (s.quote === q && !this.coinPair.has(s.base)) this.coinPair.set(s.base, pair);
  }

  private state(pair: string, now: number): PairState | null {
    if ([...this.coinPair.values()].indexOf(pair) === -1 && !this.pairs.has(pair)) {
      const s = this.symbols.get(pair);
      if (!s || this.coinPair.get(s.base) !== pair) return null;
    }
    let st = this.pairs.get(pair);
    if (!st) {
      const s = this.symbols.get(pair);
      if (!s) return null;
      st = { coin: s.base, pair, series: new SecondSeries(1200), firstAt: now, mini: null, window1h: null };
      this.pairs.set(pair, st);
    }
    return st;
  }

  applyMini(t: BinanceMiniTicker, now: number): string | null {
    const st = this.state(t.s, now);
    if (!st) return null;
    st.mini = t;
    st.series.recordPrice(t.E, t.c);
    return st.coin;
  }

  applyWindow(t: BinanceWindowTicker, now: number) {
    const st = this.state(t.s, now);
    if (st) st.window1h = t;
  }

  snapshot(coin: string, now: number): LiveSnapshot | null {
    const pair = this.coinPair.get(coin);
    const st = pair ? this.pairs.get(pair) : undefined;
    if (!st?.mini) return null;
    const m = st.mini;
    const at = m.E;
    const hist = (at - st.firstAt) / 1000;
    const ch = (sec: number) => {
      if (hist < sec) return null;
      const p0 = st.series.priceAt(at - sec * 1000);
      return p0 && p0 > 0 ? ((m.c - p0) / p0) * 100 : null;
    };
    const w = st.window1h;
    return {
      coin: st.coin,
      pair: st.pair,
      priceUsd: m.c,
      change5m: ch(300),
      change15m: ch(900),
      change1h: w ? w.P : null,
      volumeRatio1h: w && m.q > 0 ? w.q / (m.q / 24) : null,
      volume24hUsd: m.q,
      high24h: m.h,
      low24h: m.l,
    };
  }

  coins(): string[] {
    return [...this.coinPair.keys()];
  }
}

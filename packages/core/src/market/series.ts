/**
 * Fixed-capacity ring buffer of 1-second buckets for one product.
 * Each bucket stores the last price seen in that second and the traded
 * volume. Memory is O(capacity) regardless of message rate.
 */
export class SecondSeries {
  private readonly secs: Float64Array;
  private readonly close: Float64Array;
  private readonly volBase: Float64Array;
  private readonly volQuote: Float64Array;
  private readonly trades: Uint32Array;
  private firstSec: number | null = null;
  private lastSec: number | null = null;

  constructor(readonly capacitySec: number) {
    this.secs = new Float64Array(capacitySec).fill(-1);
    this.close = new Float64Array(capacitySec).fill(Number.NaN);
    this.volBase = new Float64Array(capacitySec);
    this.volQuote = new Float64Array(capacitySec);
    this.trades = new Uint32Array(capacitySec);
  }

  private slot(sec: number): number {
    const idx = sec % this.capacitySec;
    if (this.secs[idx] !== sec) {
      this.secs[idx] = sec;
      this.close[idx] = Number.NaN;
      this.volBase[idx] = 0;
      this.volQuote[idx] = 0;
      this.trades[idx] = 0;
    }
    return idx;
  }

  private accepts(sec: number): boolean {
    // Drop data older than the retention horizon.
    return this.lastSec === null || sec > this.lastSec - this.capacitySec;
  }

  private touch(sec: number) {
    if (this.firstSec === null || sec < this.firstSec) this.firstSec = sec;
    if (this.lastSec === null || sec > this.lastSec) this.lastSec = sec;
  }

  /** Record a price observation at time `ms`. The most recent write in a second wins. */
  recordPrice(ms: number, price: number) {
    const sec = Math.floor(ms / 1000);
    if (!this.accepts(sec)) return;
    const idx = this.slot(sec);
    this.close[idx] = price;
    this.touch(sec);
  }

  recordTrade(ms: number, price: number, size: number) {
    const sec = Math.floor(ms / 1000);
    if (!this.accepts(sec)) return;
    const idx = this.slot(sec);
    this.volBase[idx] = (this.volBase[idx] ?? 0) + size;
    this.volQuote[idx] = (this.volQuote[idx] ?? 0) + size * price;
    this.trades[idx] = (this.trades[idx] ?? 0) + 1;
    this.touch(sec);
  }

  /** Oldest second still inside the retention horizon (slots older than this are stale). */
  private oldestRetained(): number {
    return this.lastSec === null ? Number.NEGATIVE_INFINITY : this.lastSec - this.capacitySec + 1;
  }

  /** Oldest second with data (null if empty). */
  get firstSecond(): number | null {
    return this.firstSec;
  }

  get lastSecond(): number | null {
    return this.lastSec;
  }

  /**
   * Last known price at or before `atMs` (carry-forward), or null if no
   * price was recorded in the retained history at or before that time.
   */
  priceAt(atMs: number): number | null {
    if (this.firstSec === null) return null;
    const at = Math.floor(atMs / 1000);
    const lowest = Math.max(this.firstSec, at - this.capacitySec + 1, this.oldestRetained());
    for (let s = at; s >= lowest; s--) {
      const idx = s % this.capacitySec;
      if (this.secs[idx] === s) {
        const c = this.close[idx] as number;
        if (!Number.isNaN(c)) return c;
      }
    }
    return null;
  }

  /** Sum of quote volume and trade count over [fromMs, toMs). */
  volumeBetween(fromMs: number, toMs: number): { quote: number; base: number; trades: number } {
    let quote = 0;
    let base = 0;
    let trades = 0;
    const from = Math.floor(fromMs / 1000);
    const to = Math.floor(toMs / 1000);
    const lowest = Math.max(from, to - this.capacitySec, this.oldestRetained());
    for (let s = lowest; s < to; s++) {
      const idx = s % this.capacitySec;
      if (this.secs[idx] === s) {
        quote += this.volQuote[idx] as number;
        base += this.volBase[idx] as number;
        trades += this.trades[idx] as number;
      }
    }
    return { quote, base, trades };
  }
}

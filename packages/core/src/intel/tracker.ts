/**
 * Outcome tracker: after each signal, what did the price actually do?
 * Measures the move at fixed horizons (15 min, 1 h, 4 h, 24 h) plus the
 * best/worst excursion, and aggregates hit rates per kind × direction.
 * This is what tells whether a signal is worth anything.
 */
import type { IntelConfig } from "./config.js";
import type { Direction, IntelKind, IntelSignal, IntelSource } from "./types.js";

export interface TrackedSignal {
  id: string;
  ts: number;
  coin: string;
  kind: IntelKind;
  source: IntelSource;
  direction: Direction;
  strength: number;
  entryPrice: number;
  /** horizon (min) → return in % (null until due, or when no price was available). */
  returns: Record<string, number | null>;
  /** Benchmark (BTC) price at signal time, to measure the move relative to the market. */
  benchEntry?: number | null;
  /** horizon → return minus the benchmark's return, in % (the market effect removed). */
  excess?: Record<string, number | null>;
  /** Best move in the signal's direction and worst against it, in % (while tracked). */
  mfePct: number;
  maePct: number;
  done: boolean;
}

export interface KindStats {
  kind: IntelKind;
  direction: Direction;
  count: number;
  /** horizon → { n, hitRatePct, avgReturnPct, medianReturnPct } (returns signed in the signal's direction). */
  horizons: Record<string, { n: number; hitRatePct: number | null; avgPct: number | null; medianPct: number | null; excessHitRatePct: number | null; excessAvgPct: number | null; excessN: number }>;
  avgMfePct: number | null;
  avgMaePct: number | null;
}

const signFor = (d: Direction) => (d === "bearish" ? -1 : 1);
/** The market benchmark: excess returns are measured against Bitcoin. */
export const BENCHMARK = "BTC";

export class OutcomeTracker {
  private readonly items: TrackedSignal[] = [];

  constructor(private cfg: IntelConfig["tracking"]) {}

  track(s: IntelSignal, benchPrice: number | null = null) {
    if (s.priceUsd === null || !(s.priceUsd > 0)) return;
    if (this.items.some((x) => x.id === s.id)) return;
    this.items.push({
      id: s.id,
      ts: s.ts,
      coin: s.coin,
      kind: s.kind,
      source: s.source,
      direction: s.direction,
      strength: s.strength,
      entryPrice: s.priceUsd,
      returns: Object.fromEntries(this.cfg.horizonsMin.map((h) => [String(h), null])),
      benchEntry: s.coin !== BENCHMARK && benchPrice !== null && benchPrice > 0 ? benchPrice : null,
      excess: Object.fromEntries(this.cfg.horizonsMin.map((h) => [String(h), null])),
      mfePct: 0,
      maePct: 0,
      done: false,
    });
    if (this.items.length > this.cfg.maxTracked) this.items.splice(0, this.items.length - this.cfg.maxTracked);
  }

  /** Update with current prices; returns how many horizons were completed in this call. */
  tick(now: number, priceOf: (coin: string) => number | null): number {
    let completed = 0;
    const maxH = Math.max(...this.cfg.horizonsMin);
    for (const it of this.items) {
      if (it.done) continue;
      const p = priceOf(it.coin);
      if (p !== null && p > 0) {
        const r = ((p - it.entryPrice) / it.entryPrice) * 100;
        const inDir = r * signFor(it.direction);
        it.mfePct = Math.max(it.mfePct, inDir);
        it.maePct = Math.min(it.maePct, inDir);
      }
      for (const h of this.cfg.horizonsMin) {
        const k = String(h);
        if (it.returns[k] !== null || now < it.ts + h * 60_000) continue;
        // Late by more than 10 % of the horizon (app was off): not measurable.
        const late = p === null || now > it.ts + h * 60_000 * 1.1 + 60_000;
        if (late) it.returns[k] = Number.NaN;
        else it.returns[k] = ((p - it.entryPrice) / it.entryPrice) * 100;
        const b = priceOf(BENCHMARK);
        it.excess ??= {};
        it.excess[k] = late || !it.benchEntry || b === null || !(b > 0) ? null : (it.returns[k] as number) - ((b - it.benchEntry) / it.benchEntry) * 100;
        completed++;
      }
      if (now >= it.ts + maxH * 60_000 * 1.1 + 60_000) it.done = true;
    }
    return completed;
  }

  list(limit = 200): TrackedSignal[] {
    return this.items.slice(-limit).reverse();
  }

  stats(filter: { minStrength?: number; source?: IntelSource } = {}): KindStats[] {
    const groups = new Map<string, TrackedSignal[]>();
    for (const it of this.items) {
      if (filter.minStrength !== undefined && it.strength < filter.minStrength) continue;
      if (filter.source && it.source !== filter.source) continue;
      const key = `${it.kind}:${it.direction}`;
      const g = groups.get(key) ?? [];
      g.push(it);
      groups.set(key, g);
    }
    const hit = this.cfg.hitThresholdPct;
    const out: KindStats[] = [];
    for (const g of groups.values()) {
      const first = g[0] as TrackedSignal;
      const horizons: KindStats["horizons"] = {};
      for (const h of this.cfg.horizonsMin) {
        const k = String(h);
        const vals = g.map((it) => it.returns[k]).filter((v): v is number => v !== null && Number.isFinite(v)).map((v) => v * signFor(first.direction));
        const sorted = [...vals].sort((a, b) => a - b);
        const ex = g.map((it) => it.excess?.[k]).filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v)).map((v) => v * signFor(first.direction));
        horizons[k] = {
          excessN: ex.length,
          excessHitRatePct: ex.length ? (ex.filter((v) => v >= hit).length / ex.length) * 100 : null,
          excessAvgPct: ex.length ? ex.reduce((a, x) => a + x, 0) / ex.length : null,
          n: vals.length,
          hitRatePct: vals.length ? (vals.filter((v) => v >= hit).length / vals.length) * 100 : null,
          avgPct: vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null,
          medianPct: vals.length ? (sorted[Math.floor((sorted.length - 1) / 2)] as number) : null,
        };
      }
      const mfe = g.filter((x) => x.done || x.mfePct !== 0).map((x) => x.mfePct);
      const mae = g.filter((x) => x.done || x.maePct !== 0).map((x) => x.maePct);
      out.push({
        kind: first.kind,
        direction: first.direction,
        count: g.length,
        horizons,
        avgMfePct: mfe.length ? mfe.reduce((s, x) => s + x, 0) / mfe.length : null,
        avgMaePct: mae.length ? mae.reduce((s, x) => s + x, 0) / mae.length : null,
      });
    }
    return out.sort((a, b) => b.count - a.count);
  }

  exportState(): TrackedSignal[] {
    return this.items.map((it) => ({ ...it, returns: Object.fromEntries(Object.entries(it.returns).map(([k, v]) => [k, v !== null && Number.isNaN(v) ? -999999 : v])) }));
  }

  /** Most recent items only (smaller persisted state). */
  exportRecent(max: number): TrackedSignal[] {
    return this.exportState().slice(-max);
  }

  importState(items: TrackedSignal[]) {
    for (const it of items) this.items.push({ ...it, returns: Object.fromEntries(Object.entries(it.returns).map(([k, v]) => [k, v === -999999 ? Number.NaN : v])) });
  }
}

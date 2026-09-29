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
  horizons: Record<string, { n: number; hitRatePct: number | null; avgPct: number | null; medianPct: number | null }>;
  avgMfePct: number | null;
  avgMaePct: number | null;
}

const signFor = (d: Direction) => (d === "bearish" ? -1 : 1);

export class OutcomeTracker {
  private readonly items: TrackedSignal[] = [];

  constructor(private cfg: IntelConfig["tracking"]) {}

  track(s: IntelSignal) {
    if (s.priceUsd === null || !(s.priceUsd > 0)) return;
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
        if (p === null || now > it.ts + h * 60_000 * 1.1 + 60_000) it.returns[k] = Number.NaN;
        else it.returns[k] = ((p - it.entryPrice) / it.entryPrice) * 100;
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
        horizons[k] = {
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

  importState(items: TrackedSignal[]) {
    for (const it of items) this.items.push({ ...it, returns: Object.fromEntries(Object.entries(it.returns).map(([k, v]) => [k, v === -999999 ? Number.NaN : v])) });
  }
}

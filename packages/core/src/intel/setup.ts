/**
 * Trader-style setup engine.
 *
 * Reproduces the way discretionary crypto traders decide where to put their money, as a
 * transparent, rule-based checklist (no black box):
 *   1. Trend on two timeframes (EMA 20 / 50 / 200 stack + slope): trade with it, not against it.
 *   2. Momentum (RSI 14, MACD 12/26/9): is the move accelerating or fading?
 *   3. Market structure: breakout / breakdown of recent swing levels, pullback to support.
 *   4. Volume: relative volume and On-Balance-Volume (is money flowing in or out?).
 *   5. Volatility: Bollinger squeeze (compression often precedes a large move) and ATR for stops.
 *   6. Positioning (derivatives, contrarian): crowded longs (high funding, high long/short ratio) fuel
 *      long squeezes, and the reverse.
 *   7. Bitcoin regime: altcoins rarely hold up against a falling Bitcoin.
 * Then the plan every trader writes before entering: entry zone, invalidation (stop behind structure,
 * bounded by ATR), targets at 1.5 R and 3 R (capped by the next level), risk / reward, the position size
 * that risks a fixed share of the capital, and the maximum leverage that keeps liquidation beyond the stop.
 *
 * It is a statistical reading, not a prediction and not advice: it never places orders.
 */

import type { Candidate } from "./detectors.js";

export interface Candle {
  /** Open time (ms). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Base-asset volume. */
  v: number;
}

export type SetupBias = "LONG" | "SHORT" | "WAIT";

export interface SetupFactor {
  id: "trend" | "htf" | "momentum" | "structure" | "volume" | "positioning" | "regime";
  label: string;
  /** −1 (bearish) … +1 (bullish). */
  value: number;
  weight: number;
  note: string;
}

export interface SetupContext {
  /** Funding rate of the perpetual (% per 8 h). */
  fundingPct?: number | null;
  /** Accounts long / short ratio (Binance Futures). */
  longShortRatio?: number | null;
  /** Open-interest change (%) over the last hours. */
  oiChangePct?: number | null;
  /** Bitcoin trend −1…+1 (see `trendOf`). Ignored for BTC itself. */
  btcTrend?: number | null;
  /** Highest leverage offered on this market (caps the safe leverage). */
  maxLeverage?: number | null;
}

export interface TradeSetup {
  bias: SetupBias;
  /** Leaning of the checklist, −100 (short) … +100 (long). */
  score: number;
  /** 0–100: how much the checklist agrees with itself (NOT a probability of success). */
  confidence: number;
  price: number;
  timeframe: string;
  /** Plan for the leaning side (also computed when the bias is WAIT, for information). */
  side: "LONG" | "SHORT";
  entry: { low: number; high: number };
  stop: number;
  targets: { label: string; price: number; r: number }[];
  /** Reward / risk to the main target. */
  riskReward: number;
  /** Distance entry → stop, % of the entry price. */
  stopDistPct: number;
  /** Highest leverage whose liquidation stays well beyond the stop (1 = no leverage). */
  maxSafeLeverage: number;
  invalidation: string;
  atr: number;
  atrPct: number;
  rsi: number | null;
  squeeze: boolean;
  supports: number[];
  resistances: number[];
  indicators: { ema20: number; ema50: number; ema200: number | null; macdHist: number | null; relVolume: number | null };
  factors: SetupFactor[];
  reasons: string[];
  warnings: string[];
}

export interface SetupOptions {
  /** |score| needed for a LONG / SHORT call (default 35). */
  minScore?: number;
  /** Minimum reward / risk to the main target (default 1.5). */
  minRR?: number;
  timeframe?: string;
}

// ─── Parsers ───────────────────────────────────────────────────────────────

/** Binance `GET /api/v3/klines` (arrays: [openTime, open, high, low, close, volume, …]). */
export function parseBinanceKlines(json: unknown): Candle[] {
  if (!Array.isArray(json)) return [];
  const out: Candle[] = [];
  for (const k of json) {
    if (!Array.isArray(k) || k.length < 6) continue;
    const c = { t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) };
    if ([c.t, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite) && c.c > 0) out.push(c);
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Coinbase Advanced public `…/market/products/{id}/candles` ({ candles: [{ start (s), low, high, open, close, volume }] }, newest first). */
export function parseCoinbaseCandles(json: unknown): Candle[] {
  const list = (json as { candles?: unknown })?.candles;
  if (!Array.isArray(list)) return [];
  const out: Candle[] = [];
  for (const k of list as Record<string, unknown>[]) {
    const c = { t: Number(k.start) * 1000, o: Number(k.open), h: Number(k.high), l: Number(k.low), c: Number(k.close), v: Number(k.volume) };
    if ([c.t, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite) && c.c > 0) out.push(c);
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Group consecutive candles by `n` (e.g. 1 h → 4 h). Incomplete leading groups are dropped. */
export function aggregateCandles(cs: Candle[], n: number): Candle[] {
  const out: Candle[] = [];
  const start = cs.length % n;
  for (let i = start; i + n <= cs.length; i += n) {
    const g = cs.slice(i, i + n);
    out.push({ t: g[0]!.t, o: g[0]!.o, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), c: g[g.length - 1]!.c, v: g.reduce((s, x) => s + x.v, 0) });
  }
  return out;
}

// ─── Indicators ────────────────────────────────────────────────────────────

export function ema(xs: number[], period: number): number[] {
  const out: number[] = [];
  if (xs.length < period) return out;
  const k = 2 / (period + 1);
  let e = xs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = 0; i < xs.length; i++) {
    if (i < period - 1) {
      out.push(Number.NaN);
      continue;
    }
    if (i >= period) e = xs[i]! * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

/** Wilder RSI. */
export function rsi(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(Number.NaN);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + Math.max(0, d)) / period;
    loss = (loss * (period - 1) + Math.max(0, -d)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(closes: number[], fast = 12, slow = 26, signal = 9): { line: number[]; signal: number[]; hist: number[] } {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = closes.map((_, i) => (Number.isFinite(f[i]!) && Number.isFinite(s[i]!) ? f[i]! - s[i]! : Number.NaN));
  const first = line.findIndex(Number.isFinite);
  const sig: number[] = new Array(closes.length).fill(Number.NaN);
  if (first >= 0) {
    const e = ema(line.slice(first), signal);
    e.forEach((x, i) => (sig[first + i] = x));
  }
  return { line, signal: sig, hist: line.map((x, i) => (Number.isFinite(x) && Number.isFinite(sig[i]!) ? x - sig[i]! : Number.NaN)) };
}

/** Wilder ATR. */
export function atr(cs: Candle[], period = 14): number[] {
  const out: number[] = new Array(cs.length).fill(Number.NaN);
  if (cs.length <= period) return out;
  const tr = cs.map((c, i) => (i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - cs[i - 1]!.c), Math.abs(c.l - cs[i - 1]!.c))));
  let a = tr.slice(1, period + 1).reduce((s, x) => s + x, 0) / period;
  out[period] = a;
  for (let i = period + 1; i < cs.length; i++) {
    a = (a * (period - 1) + tr[i]!) / period;
    out[i] = a;
  }
  return out;
}

/** Bollinger band width (upper − lower) / middle, per bar. */
export function bollingerWidth(closes: number[], period = 20, k = 2): number[] {
  return closes.map((_, i) => {
    if (i < period - 1) return Number.NaN;
    const w = closes.slice(i - period + 1, i + 1);
    const m = w.reduce((s, x) => s + x, 0) / period;
    const sd = Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / period);
    return m > 0 ? (2 * k * sd) / m : Number.NaN;
  });
}

export function obv(cs: Candle[]): number[] {
  const out: number[] = [];
  let v = 0;
  cs.forEach((c, i) => {
    if (i > 0) v += c.c > cs[i - 1]!.c ? c.v : c.c < cs[i - 1]!.c ? -c.v : 0;
    out.push(v);
  });
  return out;
}

/** Swing highs / lows (fractals: a bar higher / lower than `w` bars on each side), newest last. */
export function swings(cs: Candle[], w = 3): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = w; i < cs.length - w; i++) {
    const c = cs[i]!;
    let hi = true;
    let lo = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue;
      if (cs[j]!.h >= c.h) hi = false;
      if (cs[j]!.l <= c.l) lo = false;
    }
    if (hi) highs.push(c.h);
    if (lo) lows.push(c.l);
  }
  return { highs, lows };
}

/** Merge levels closer than `tol` (absolute), keeping their average. */
function cluster(levels: number[], tol: number): number[] {
  const s = [...levels].sort((a, b) => a - b);
  const out: { sum: number; n: number }[] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x - last.sum / last.n <= tol) {
      last.sum += x;
      last.n++;
    } else out.push({ sum: x, n: 1 });
  }
  return out.map((g) => g.sum / g.n);
}

const last = (xs: number[]) => {
  for (let i = xs.length - 1; i >= 0; i--) if (Number.isFinite(xs[i]!)) return xs[i]!;
  return Number.NaN;
};
const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const fmt = (x: number) => {
  const a = Math.abs(x);
  const d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 3 : a >= 0.01 ? 5 : 8;
  return x.toLocaleString("fr-FR", { maximumFractionDigits: d, minimumFractionDigits: 0 });
};

/**
 * Trend of a series, −1 … +1: EMA stack (price / 20 / 50 / 200) and the slope of the EMA 50.
 * Works with fewer than 200 bars (the 200 is then left out).
 */
export function trendOf(cs: Candle[]): { value: number; note: string } | null {
  if (cs.length < 60) return null;
  const closes = cs.map((c) => c.c);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = closes.length >= 210 ? ema(closes, 200) : [];
  const p = closes[closes.length - 1]!;
  const a = last(e20);
  const b = last(e50);
  const c = e200.length ? last(e200) : Number.NaN;
  const votes = [Math.sign(p - a), Math.sign(a - b)];
  if (Number.isFinite(c)) votes.push(Math.sign(b - c), Math.sign(p - c));
  const stack = votes.reduce((s, x) => s + x, 0) / votes.length;
  const b10 = e50[e50.length - 11];
  const slope = b10 && Number.isFinite(b10) ? (b - b10) / b10 : 0;
  // A 1 % move of the EMA 50 over 10 bars is a clear slope on most timeframes.
  const value = clamp(stack * 0.7 + clamp(slope / 0.01) * 0.3);
  const note =
    value > 0.5 ? "tendance haussière nette (moyennes 20 > 50" + (Number.isFinite(c) ? " > 200" : "") + ", pente positive)" : value > 0.15 ? "tendance plutôt haussière" : value < -0.5 ? "tendance baissière nette (moyennes 20 < 50" + (Number.isFinite(c) ? " < 200" : "") + ", pente négative)" : value < -0.15 ? "tendance plutôt baissière" : "pas de tendance claire (range)";
  return { value, note };
}

// ─── The setup ─────────────────────────────────────────────────────────────

/**
 * Analyse one market. `primary` = main timeframe (1 h recommended, ≥ 100 bars, 250+ ideal);
 * `higher` = higher timeframe (4 h) for confirmation, or null.
 */
export function analyzeSetup(primary: Candle[], higher: Candle[] | null, ctx: SetupContext = {}, opts: SetupOptions = {}): TradeSetup | null {
  const cs = primary.filter((c) => c.c > 0);
  if (cs.length < 60) return null;
  const minScore = opts.minScore ?? 35;
  const minRR = opts.minRR ?? 1.5;
  const closes = cs.map((c) => c.c);
  const price = closes[closes.length - 1]!;
  const at = atr(cs);
  const A = last(at);
  if (!Number.isFinite(A) || A <= 0) return null;
  const e20 = last(ema(closes, 20));
  const e50 = last(ema(closes, 50));
  const e200s = closes.length >= 210 ? last(ema(closes, 200)) : null;
  const r = rsi(closes);
  const R = last(r);
  const m = macd(closes);
  const hist = m.hist.filter(Number.isFinite);
  const H = hist.length ? hist[hist.length - 1]! : null;
  const Hprev = hist.length > 3 ? hist[hist.length - 4]! : null;
  const bw = bollingerWidth(closes).filter(Number.isFinite);
  const bwNow = bw[bw.length - 1];
  const bwRank = bw.length > 50 && bwNow !== undefined ? bw.slice(-120).filter((x) => x < bwNow).length / Math.min(120, bw.length) : null;
  const squeeze = bwRank !== null && bwRank <= 0.2;
  const vols = cs.map((c) => c.v);
  const avgVol = vols.slice(-21, -1).reduce((s, x) => s + x, 0) / 20;
  const relVol = avgVol > 0 ? vols[vols.length - 1]! / avgVol : null;
  const ob = obv(cs);

  const factors: SetupFactor[] = [];
  const reasons: string[] = [];
  const warnings: string[] = [];

  // 1. Trend (main timeframe)
  const tr = trendOf(cs);
  factors.push({ id: "trend", label: `Tendance (${opts.timeframe ?? "1 h"})`, value: tr?.value ?? 0, weight: 25, note: tr?.note ?? "historique trop court" });

  // 2. Higher timeframe
  const ht = higher && higher.length >= 60 ? trendOf(higher) : null;
  factors.push({ id: "htf", label: "Tendance de fond (4 h)", value: ht?.value ?? 0, weight: 15, note: ht ? ht.note : "unité de temps supérieure indisponible" });

  // 3. Momentum: RSI distance from 50 and MACD histogram direction.
  let mom = 0;
  const momNotes: string[] = [];
  if (Number.isFinite(R)) {
    mom += clamp((R - 50) / 20) * 0.6;
    momNotes.push(`RSI ${R.toFixed(0)}`);
    if (R >= 75) {
      mom -= 0.4;
      warnings.push(`RSI ${R.toFixed(0)} : suracheté, risque de repli avant de continuer`);
    } else if (R <= 25) {
      mom += 0.4;
      warnings.push(`RSI ${R.toFixed(0)} : survendu, risque de rebond violent`);
    }
  }
  if (H !== null) {
    const rising = Hprev !== null && H > Hprev;
    mom += (H > 0 ? 0.25 : -0.25) + (Hprev === null ? 0 : rising ? 0.15 : -0.15);
    momNotes.push(`MACD ${H > 0 ? "positif" : "négatif"}${Hprev === null ? "" : rising ? " et en accélération" : " et en perte de vitesse"}`);
  }
  factors.push({ id: "momentum", label: "Momentum", value: clamp(mom), weight: 15, note: momNotes.join(", ") || "—" });

  // 4. Structure: swing levels, breakouts, pullbacks.
  const sw = swings(cs.slice(-200));
  const levels = cluster([...sw.highs, ...sw.lows], A * 0.5);
  const supports = levels.filter((x) => x < price).sort((a, b) => b - a).slice(0, 4);
  const resistances = levels.filter((x) => x > price).sort((a, b) => a - b).slice(0, 4);
  const prior = cs.slice(-21, -1);
  const hi20 = Math.max(...prior.map((c) => c.h));
  const lo20 = Math.min(...prior.map((c) => c.l));
  let st = 0;
  let stNote = "au milieu de sa fourchette récente";
  const volOk = relVol !== null && relVol >= 1.5;
  if (price > hi20) {
    st = volOk ? 1 : 0.6;
    stNote = `cassure au-dessus du plus haut des 20 dernières bougies (${fmt(hi20)})${volOk ? " avec du volume" : ", volume encore faible"}`;
  } else if (price < lo20) {
    st = volOk ? -1 : -0.6;
    stNote = `cassure sous le plus bas des 20 dernières bougies (${fmt(lo20)})${volOk ? " avec du volume" : ", volume encore faible"}`;
  } else {
    const nearSup = supports[0] !== undefined && price - supports[0] <= A * 0.8;
    const nearRes = resistances[0] !== undefined && resistances[0] - price <= A * 0.8;
    const t = tr?.value ?? 0;
    if (nearSup && t > 0.15) {
      st = 0.5;
      stNote = `repli sur un support (${fmt(supports[0]!)}) dans une tendance haussière`;
    } else if (nearRes && t < -0.15) {
      st = -0.5;
      stNote = `rebond sous une résistance (${fmt(resistances[0]!)}) dans une tendance baissière`;
    } else if (nearRes) {
      st = -0.2;
      stNote = `bute sous une résistance (${fmt(resistances[0]!)})`;
    } else if (nearSup) {
      st = 0.2;
      stNote = `posé sur un support (${fmt(supports[0]!)})`;
    }
  }
  factors.push({ id: "structure", label: "Structure (niveaux)", value: st, weight: 15, note: stNote });

  // 5. Volume: OBV slope over 20 bars relative to the average volume, amplified by relative volume.
  const obvSlope = avgVol > 0 && ob.length > 21 ? (ob[ob.length - 1]! - ob[ob.length - 21]!) / (avgVol * 20) : 0;
  const vol = clamp(obvSlope * 2);
  factors.push({ id: "volume", label: "Volume (OBV)", value: vol, weight: 10, note: `${vol > 0.2 ? "l'argent entre (OBV en hausse)" : vol < -0.2 ? "l'argent sort (OBV en baisse)" : "flux neutre"}${relVol !== null ? `, volume ×${relVol.toFixed(1)} la moyenne` : ""}` });

  // 6. Derivatives positioning — contrarian: a crowded side is fuel for a squeeze the other way.
  let pos = 0;
  const posNotes: string[] = [];
  const f = ctx.fundingPct;
  if (f !== null && f !== undefined && Number.isFinite(f)) {
    if (f >= 0.05) {
      pos -= clamp((f - 0.03) / 0.07, 0, 1) * 0.6;
      posNotes.push(`financement ${f.toFixed(3)} % : acheteurs à levier trop nombreux`);
    } else if (f <= -0.02) {
      pos += clamp((-f - 0.01) / 0.05, 0, 1) * 0.6;
      posNotes.push(`financement ${f.toFixed(3)} % : vendeurs à découvert nombreux (risque de short squeeze)`);
    } else posNotes.push(`financement ${f.toFixed(3)} % : neutre`);
  }
  const ls = ctx.longShortRatio;
  if (ls !== null && ls !== undefined && Number.isFinite(ls)) {
    if (ls >= 2.5) {
      pos -= 0.4;
      posNotes.push(`ratio long/short ${ls.toFixed(2)} : foule très acheteuse`);
    } else if (ls <= 0.8) {
      pos += 0.4;
      posNotes.push(`ratio long/short ${ls.toFixed(2)} : foule vendeuse`);
    }
  }
  const oi = ctx.oiChangePct;
  if (oi !== null && oi !== undefined && Number.isFinite(oi) && Math.abs(oi) >= 3) {
    // New money entering with the trend confirms it; leaving means the move is being closed.
    const t = tr?.value ?? 0;
    pos += oi > 0 ? Math.sign(t) * 0.3 : -Math.sign(t) * 0.2;
    posNotes.push(`intérêt ouvert ${oi > 0 ? "+" : ""}${oi.toFixed(1)} %`);
  }
  factors.push({ id: "positioning", label: "Positionnement (dérivés)", value: clamp(pos), weight: 10, note: posNotes.join(" · ") || "pas de données dérivés" });

  // 7. Bitcoin regime.
  const bt = ctx.btcTrend;
  factors.push({ id: "regime", label: "Régime Bitcoin", value: bt !== null && bt !== undefined && Number.isFinite(bt) ? clamp(bt) : 0, weight: 10, note: bt === null || bt === undefined ? "non utilisé" : bt > 0.3 ? "Bitcoin en tendance haussière" : bt < -0.3 ? "Bitcoin en tendance baissière" : "Bitcoin sans tendance" });

  const totalW = factors.reduce((s, x) => s + x.weight, 0);
  const score = Math.round((factors.reduce((s, x) => s + x.value * x.weight, 0) / totalW) * 100);
  const side: "LONG" | "SHORT" = score >= 0 ? "LONG" : "SHORT";
  const sgn = side === "LONG" ? 1 : -1;

  // ── The plan (for the leaning side).
  // Entry: from the current price back to 0.5 ATR (or the EMA 20 if it is closer): no chasing.
  const pull = Math.min(A * 0.5, Math.abs(price - e20) <= A ? Math.abs(price - e20) : A * 0.5);
  const entry = side === "LONG" ? { low: price - pull, high: price } : { low: price, high: price + pull };
  const mid = (entry.low + entry.high) / 2;
  // Stop behind the nearest structure beyond the entry zone, bounded between 1 and 3 ATR.
  const structural = side === "LONG" ? supports.find((x) => x < entry.low - A * 0.1) : resistances.find((x) => x > entry.high + A * 0.1);
  let stopDist = structural !== undefined ? Math.abs(mid - structural) + A * 0.3 : A * 1.5;
  stopDist = Math.max(A * 1, Math.min(A * 3, stopDist));
  const stop = mid - sgn * stopDist;
  const t1 = mid + sgn * stopDist * 1.5;
  const t2 = mid + sgn * stopDist * 3;
  // The next level in the way caps the realistic target.
  const blocking = side === "LONG" ? resistances.find((x) => x > mid + stopDist * 0.5) : supports.find((x) => x < mid - stopDist * 0.5);
  const mainTarget = blocking !== undefined && Math.abs(blocking - mid) < Math.abs(t2 - mid) ? blocking : t2;
  const riskReward = Math.round((Math.abs(mainTarget - mid) / stopDist) * 10) / 10;
  const targets = [
    { label: "Objectif 1 (1,5 R)", price: t1, r: 1.5 },
    { label: "Objectif 2 (3 R)", price: t2, r: 3 },
  ];
  if (blocking !== undefined && Math.abs(blocking - mid) < Math.abs(t2 - mid)) targets.push({ label: side === "LONG" ? "Résistance sur le chemin" : "Support sur le chemin", price: blocking, r: Math.round((Math.abs(blocking - mid) / stopDist) * 10) / 10 });
  targets.sort((a, b) => a.r - b.r);
  const stopDistPct = (stopDist / mid) * 100;
  // Liquidation at roughly 1/L (minus ~0.5 % maintenance margin) must stay 1.5× beyond the stop.
  let maxSafeLeverage = Math.max(1, Math.floor(1 / ((stopDistPct / 100) * 1.5 + 0.005)));
  maxSafeLeverage = Math.min(maxSafeLeverage, 10, ctx.maxLeverage && ctx.maxLeverage > 0 ? Math.floor(ctx.maxLeverage) : 10);

  // ── Confidence: agreement of the factors with the leaning side, squeeze, room to the target.
  const agreeing = factors.filter((x) => x.value * sgn > 0.15).length;
  const opposing = factors.filter((x) => x.value * sgn < -0.15);
  let confidence = Math.abs(score) * 0.7 + agreeing * 6 - opposing.length * 8;
  if (squeeze && Math.abs(st) >= 0.6) {
    confidence += 10;
    reasons.push("sortie d'une compression de volatilité (Bollinger resserrées) : les mouvements qui suivent sont souvent amples");
  } else if (squeeze) {
    warnings.push("volatilité compressée : un mouvement fort se prépare, direction pas encore confirmée");
  }
  if (riskReward < minRR) confidence -= 15;
  confidence = Math.round(Math.max(0, Math.min(100, confidence)));

  // ── Decision.
  const htOpposes = ht !== null && ht.value * sgn < -0.4;
  const trOpposes = tr !== null && tr.value * sgn < -0.2;
  let bias: SetupBias = side;
  if (Math.abs(score) < minScore) bias = "WAIT";
  if (trOpposes || htOpposes) bias = "WAIT";
  if (riskReward < minRR) bias = "WAIT";

  for (const x of factors) if (x.value * sgn > 0.15) reasons.push(`${x.label} : ${x.note}`);
  for (const x of opposing) warnings.push(`contre le plan — ${x.label} : ${x.note}`);
  if (bias === "WAIT") {
    if (Math.abs(score) < minScore) warnings.unshift(`signaux pas assez alignés (score ${score}, il faut ±${minScore})`);
    if (trOpposes || htOpposes) warnings.unshift(`${side === "LONG" ? "achat" : "vente"} à contre-tendance : un trader attend`);
    if (riskReward < minRR) warnings.unshift(`rapport gain/risque ${riskReward} trop faible (niveau proche) : pas assez de place jusqu'à l'objectif`);
  }
  if (e200s !== null && side === "LONG" && price < e200s) warnings.push("sous la moyenne 200 : marché baissier de fond");
  if (e200s !== null && side === "SHORT" && price > e200s) warnings.push("au-dessus de la moyenne 200 : marché haussier de fond");

  const invalidation =
    side === "LONG"
      ? `Le plan est faux si une bougie ${opts.timeframe ?? "1 h"} clôture sous ${fmt(stop)} (stop). Ne pas déplacer le stop plus bas.`
      : `Le plan est faux si une bougie ${opts.timeframe ?? "1 h"} clôture au-dessus de ${fmt(stop)} (stop). Ne pas déplacer le stop plus haut.`;

  return {
    bias,
    score,
    confidence,
    price,
    timeframe: opts.timeframe ?? "1 h",
    side,
    entry,
    stop,
    targets,
    riskReward,
    stopDistPct: Math.round(stopDistPct * 100) / 100,
    maxSafeLeverage,
    invalidation,
    atr: A,
    atrPct: Math.round((A / price) * 10000) / 100,
    rsi: Number.isFinite(R) ? Math.round(R * 10) / 10 : null,
    squeeze,
    supports,
    resistances,
    indicators: { ema20: e20, ema50: e50, ema200: e200s, macdHist: H, relVolume: relVol === null ? null : Math.round(relVol * 100) / 100 },
    factors,
    reasons,
    warnings,
  };
}

/** Position that risks `riskPct` % of `capital` if the stop is hit. */
export function positionSize(s: Pick<TradeSetup, "stopDistPct" | "entry">, capital: number, riskPct: number) {
  const riskUsd = (capital * riskPct) / 100;
  const notional = s.stopDistPct > 0 ? riskUsd / (s.stopDistPct / 100) : 0;
  const mid = (s.entry.low + s.entry.high) / 2;
  return { riskUsd, notional, quantity: mid > 0 ? notional / mid : 0, leverageNeeded: capital > 0 ? notional / capital : 0 };
}

/** Liquidation price (isolated margin, approximate) for a leverage L. */
export function liquidationPrice(entry: number, leverage: number, side: "LONG" | "SHORT", maintenancePct = 0.5): number {
  const d = 1 / leverage - maintenancePct / 100;
  return side === "LONG" ? entry * (1 - d) : entry * (1 + d);
}

/** Setup → intel candidate (only LONG / SHORT). */
export function setupCandidate(coin: string, coinName: string | null, s: TradeSetup, url: string | null): Candidate | null {
  if (s.bias === "WAIT") return null;
  const long = s.bias === "LONG";
  const tgt = s.targets.map((t) => fmt(t.price)).join(" / ");
  return {
    coin,
    coinName,
    kind: long ? "SETUP_LONG" : "SETUP_SHORT",
    direction: long ? "bullish" : "bearish",
    source: "setup",
    strength: s.confidence,
    title: `${coin} : setup ${s.bias} (${s.timeframe}) · entrée ${fmt(s.entry.low)}–${fmt(s.entry.high)} · stop ${fmt(s.stop)} · objectifs ${tgt} · gain/risque ${s.riskReward}`,
    reasons: [
      ...s.reasons.slice(0, 6),
      `stop à ${s.stopDistPct} % (${(s.stopDistPct / (s.atrPct || 1)).toFixed(1)} ATR) : ${s.invalidation}`,
      `levier raisonnable maximal ×${s.maxSafeLeverage} (liquidation au-delà du stop)`,
      ...s.warnings.slice(0, 3).map((w) => `⚠️ ${w}`),
      "plan statistique, pas un conseil : risque de perte",
    ],
    metrics: {
      score: s.score,
      confidence: s.confidence,
      entryLow: s.entry.low,
      entryHigh: s.entry.high,
      stop: s.stop,
      target1: s.targets[0]?.price ?? null,
      target2: s.targets[s.targets.length - 1]?.price ?? null,
      riskReward: s.riskReward,
      stopDistPct: s.stopDistPct,
      maxSafeLeverage: s.maxSafeLeverage,
      rsi: s.rsi,
      timeframe: s.timeframe,
    },
    priceUsd: s.price,
    url,
  };
}

/**
 * Trend verdict ("avis de tendance"): one stable opinion per coin instead of a stream of contradictory
 * 5-minute events.
 *
 * Score −100…+100 =
 *   60 % structure (the trader setup: 1 h + 4 h trend, momentum, levels, volume, positioning, BTC regime)
 * + 25 % recent evidence (signals of the last hours, decayed, weighted by strength and measured reliability)
 * + 15 % talk (news / Reddit headlines about the coin, last 6 h).
 * States: STRONG_UP ≥ 45 · UP ≥ 20 · NEUTRAL · DOWN ≤ −20 · STRONG_DOWN ≤ −45.
 *
 * Anti-flip rules (what makes it an opinion and not noise):
 * - a new state must be seen on 2 evaluations at least 8 min apart before it replaces the current one;
 * - a verdict is kept at least 2 h (switching to the opposite side earlier needs |score| ≥ 55), unless
 *   the price breaks the verdict's invalidation level, which ends it at once.
 * Statistical reading, not investment advice.
 */
import type { TradeSetup } from "./setup.js";
import type { Direction, IntelKind, IntelSource } from "./types.js";

export type VerdictState = "STRONG_UP" | "UP" | "NEUTRAL" | "DOWN" | "STRONG_DOWN";

export const VERDICT_LABEL: Record<VerdictState, string> = {
  STRONG_UP: "HAUSSIER FORT",
  UP: "HAUSSIER",
  NEUTRAL: "NEUTRE",
  DOWN: "BAISSIER",
  STRONG_DOWN: "BAISSIER FORT",
};

export interface VerdictEvidence {
  direction: Direction;
  strength: number;
  ts: number;
  kind: IntelKind;
  source: IntelSource;
  /** Measured 1 h hit rate of this kind × direction (%), null = not measured yet. */
  hitRate: number | null;
}

export interface VerdictInput {
  setup: TradeSetup;
  signals: VerdictEvidence[];
  talk: { direction: Direction; ts: number }[];
  price: number;
  now: number;
}

export interface VerdictScore {
  score: number;
  parts: { structure: number; evidence: number; talk: number };
  reasons: string[];
}

export interface VerdictMemory {
  state: VerdictState;
  since: number;
  score: number;
  /** Price when the verdict started, and the level that would prove it wrong. */
  entry: number;
  invalidation: number | null;
  targets: number[];
  pending: { state: VerdictState; count: number; at: number } | null;
  lastEval: number;
}

export interface VerdictChange {
  from: VerdictState;
  to: VerdictState;
  why: "confirmé" | "invalidation" | "renforcement";
}

const H = 3_600_000;
const MIN_HOLD = 2 * H;
const CONFIRM_GAP = 8 * 60_000;
const clamp = (x: number, lo = -100, hi = 100) => Math.max(lo, Math.min(hi, x));
const side = (s: VerdictState) => (s === "UP" || s === "STRONG_UP" ? 1 : s === "DOWN" || s === "STRONG_DOWN" ? -1 : 0);
const sign = (d: Direction) => (d === "bullish" ? 1 : d === "bearish" ? -1 : 0);

export function stateOf(score: number): VerdictState {
  return score >= 45 ? "STRONG_UP" : score >= 20 ? "UP" : score <= -45 ? "STRONG_DOWN" : score <= -20 ? "DOWN" : "NEUTRAL";
}

export const VERDICT_KIND: Record<"up" | "down" | "exit", IntelKind> = { up: "TREND_UP", down: "TREND_DOWN", exit: "TREND_EXIT" };

/** Raw score of a coin right now (no memory). */
export function scoreVerdict(i: VerdictInput): VerdictScore {
  const reasons: string[] = [];
  const structure = clamp(i.setup.score);
  // Recent evidence: decayed (half-life 45 min), strength-weighted; unreliable kinds count less.
  let ev = 0;
  let evN = 0;
  for (const s of i.signals) {
    if (s.source === "setup" || s.kind.startsWith("TREND_")) continue;
    const age = i.now - s.ts;
    if (age < 0 || age > 4 * H) continue;
    const w = Math.pow(0.5, age / (45 * 60_000)) * (s.strength / 100) * (s.hitRate === null ? 1 : Math.max(0.3, Math.min(1.5, s.hitRate / 50)));
    ev += sign(s.direction) * w;
    evN += w;
  }
  const evidence = clamp(evN > 0 ? (ev / Math.max(1, evN)) * 100 * Math.min(1, evN / 1.5) : 0);
  const recentTalk = i.talk.filter((t) => i.now - t.ts < 6 * H);
  const talkSum = recentTalk.reduce((a, t) => a + sign(t.direction), 0);
  const talk = clamp(recentTalk.length ? (talkSum / recentTalk.length) * 100 * Math.min(1, recentTalk.length / 4) : 0);
  const score = Math.round(structure * 0.6 + evidence * 0.25 + talk * 0.15);

  const top = i.setup.factors
    .filter((f) => Math.abs(f.value) >= 0.3)
    .sort((a, b) => Math.abs(b.value * b.weight) - Math.abs(a.value * a.weight))
    .slice(0, 3);
  for (const f of top) reasons.push(`${f.value > 0 ? "▲" : "▼"} ${f.label} : ${f.note}`);
  if (Math.abs(evidence) >= 25) reasons.push(`${evidence > 0 ? "▲" : "▼"} signaux récents plutôt ${evidence > 0 ? "haussiers" : "baissiers"} (${Math.round(evidence)})`);
  if (Math.abs(talk) >= 30 && recentTalk.length >= 2) reasons.push(`${talk > 0 ? "▲" : "▼"} actus / Reddit ${talk > 0 ? "positives" : "négatives"} (${recentTalk.length} titres en 6 h)`);
  return { score, parts: { structure: Math.round(structure), evidence: Math.round(evidence), talk: Math.round(talk) }, reasons };
}

/**
 * One evaluation: the new memory and, when the verdict really changes, the change to announce.
 * `levels` come from the trader setup of the moment (used when a new verdict starts).
 */
export function stepVerdict(mem: VerdictMemory | null, scored: VerdictScore, setup: TradeSetup, price: number, now: number): { mem: VerdictMemory; change: VerdictChange | null } {
  const target = stateOf(scored.score);
  const start = (state: VerdictState): VerdictMemory => {
    const up = side(state) > 0;
    const down = side(state) < 0;
    const aligned = (up && setup.side === "LONG") || (down && setup.side === "SHORT");
    return {
      state,
      since: now,
      score: scored.score,
      entry: price,
      invalidation: aligned ? setup.stop : null,
      targets: aligned ? setup.targets.map((t) => t.price) : [],
      pending: null,
      lastEval: now,
    };
  };
  if (!mem) {
    // First look at a coin: starts neutral; an opinion has to be confirmed like any other change.
    const m = start("NEUTRAL");
    return { mem: target === "NEUTRAL" ? m : { ...m, pending: { state: target, count: 1, at: now } }, change: null };
  }
  const m: VerdictMemory = { ...mem, score: scored.score, lastEval: now };
  // Invalidation: the price went through the level that proves the current verdict wrong.
  const s = side(m.state);
  if (s !== 0 && m.invalidation !== null && (s > 0 ? price < m.invalidation : price > m.invalidation)) {
    const next = side(target) === s ? "NEUTRAL" : target;
    return { mem: start(next), change: { from: m.state, to: next, why: "invalidation" } };
  }
  if (target === m.state) return { mem: { ...m, pending: null }, change: null };
  // Same side, stronger or weaker: upgrades are announced, downgrades are silent.
  if (side(target) === s && s !== 0) {
    const stronger = target === "STRONG_UP" || target === "STRONG_DOWN";
    return { mem: { ...m, state: target, pending: null }, change: stronger ? { from: m.state, to: target, why: "renforcement" } : null };
  }
  // A real change of side: needs confirmation, and respect of the minimum holding time.
  const opposite = s !== 0 && side(target) === -s;
  if (opposite && now - m.since < MIN_HOLD && Math.abs(scored.score) < 55) return { mem: { ...m, pending: null }, change: null };
  const p = m.pending && m.pending.state === target ? m.pending : { state: target, count: 0, at: 0 };
  if (p.count > 0 && now - p.at < CONFIRM_GAP) return { mem: { ...m, pending: p }, change: null };
  const count = p.count + 1;
  if (count < 2) return { mem: { ...m, pending: { state: target, count, at: now } }, change: null };
  return { mem: start(target), change: { from: m.state, to: target, why: "confirmé" } };
}

/** Horizon in words, from the volatility of the coin (ATR % on 1 h). */
export function verdictHorizon(atrPct: number): string {
  return atrPct >= 2.5 ? "quelques heures à 1 jour" : atrPct >= 1 ? "1 à 3 jours" : "plusieurs jours";
}

/**
 * Strategy Engine — turns radar rows into ENTRY intents, deterministically.
 * It never places orders: every intent goes through the Risk Engine.
 */
import type { RadarRow } from "../signals/engine.js";
import type { Condition, Strategy } from "./config.js";

export interface ConditionResult {
  condition: Condition;
  value: number | null;
  passed: boolean;
  label: string;
}

const LABELS: Record<Condition["metric"], string> = {
  priceChangePct: "Prix",
  volumeRatio: "Volume ratio",
  score: "Score",
  spreadPct: "Spread",
  accelerationPct: "Accélération",
  liquidityScore: "Liquidité",
};

export function conditionLabel(c: Condition): string {
  const unit = c.metric === "volumeRatio" ? "x" : c.metric === "score" || c.metric === "liquidityScore" ? "" : " %";
  return `${LABELS[c.metric]}${c.window ? ` ${c.window}` : ""} ${c.op} ${c.value}${unit}`;
}

export function metricValue(c: Condition, row: RadarRow): number | null {
  const m = row.metrics;
  switch (c.metric) {
    case "priceChangePct":
      return c.window ? m.changes[c.window] : null;
    case "volumeRatio":
      return m.volumeRatio;
    case "score":
      return row.scores.composite;
    case "spreadPct":
      return m.spreadPct;
    case "accelerationPct":
      return m.accelerationPct;
    case "liquidityScore":
      return row.scores.liquidity;
  }
}

function compare(v: number, op: Condition["op"], x: number): boolean {
  switch (op) {
    case ">":
      return v > x;
    case ">=":
      return v >= x;
    case "<":
      return v < x;
    case "<=":
      return v <= x;
  }
}

/** Unknown values (null) never satisfy a condition. */
export function evaluateConditions(strategy: Strategy, row: RadarRow): ConditionResult[] {
  return strategy.entry.conditions.map((condition) => {
    const value = metricValue(condition, row);
    const passed = value !== null && Number.isFinite(value) && compare(value, condition.op, condition.value);
    return { condition, value, passed, label: conditionLabel(condition) };
  });
}

export function inUniverse(strategy: Strategy, row: RadarRow): boolean {
  const m = row.metrics;
  return (
    strategy.universe.quoteCurrencies.map((q) => q.toUpperCase()).includes(m.quoteCurrency.toUpperCase()) &&
    !strategy.universe.excludeBases.map((b) => b.toUpperCase()).includes(m.baseCurrency.toUpperCase())
  );
}

export interface EntryCandidate {
  strategy: Strategy;
  row: RadarRow;
  results: ConditionResult[];
  reason: string;
}

/** Strategies × rows whose conditions are all satisfied. */
export function findEntryCandidates(strategies: Strategy[], rows: RadarRow[]): EntryCandidate[] {
  const out: EntryCandidate[] = [];
  for (const strategy of strategies) {
    if (!strategy.enabled) continue;
    for (const row of rows) {
      if (row.metrics.price === null || !inUniverse(strategy, row)) continue;
      const results = evaluateConditions(strategy, row);
      if (results.every((r) => r.passed)) {
        const reason = results.map((r) => `${r.label} (${r.value === null ? "—" : r.value.toFixed(2)})`).join(" ET ");
        out.push({ strategy, row, results, reason });
      }
    }
  }
  return out;
}

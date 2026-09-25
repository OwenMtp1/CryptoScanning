/**
 * Circuit breakers (spec §12). A tripped breaker blocks NEW entries and
 * rotations (never protective exits), keeps state, and is reported.
 * "Manual" breakers stay tripped until the user explicitly re-enables
 * trading; "auto" ones recover when their condition clears.
 */
export type BreakerId =
  | "EMERGENCY_STOP"
  | "DAILY_LOSS"
  | "WEEKLY_LOSS"
  | "API_ERRORS"
  | "STALE_DATA"
  | "SLIPPAGE"
  | "EXECUTION_REJECTIONS"
  | "TRADE_RATE";

export interface BreakerState {
  id: BreakerId;
  reason: string;
  since: number;
  manualReset: boolean;
}

export interface BreakerInputs {
  now: number;
  feedHealthy: boolean;
  feedReason: string | null;
  lossUsed24h: number;
  lossUsed7d: number;
  maxDailyLoss: number;
  maxWeeklyLoss: number;
  consecutiveErrors: number;
  maxConsecutiveErrors: number;
  executionRejectionsLastHour: number;
  maxExecutionRejectionsPerHour: number;
  fillsLastHour: number;
  maxTradesPerHour: number;
}

export interface BreakerChange {
  kind: "tripped" | "recovered";
  breaker: BreakerState;
}

export class CircuitBreakers {
  private readonly tripped = new Map<BreakerId, BreakerState>();

  constructor(initial: BreakerState[] = []) {
    // Only manual breakers are restored after a restart (auto ones re-evaluate).
    for (const b of initial) if (b.manualReset) this.tripped.set(b.id, b);
  }

  list(): BreakerState[] {
    return [...this.tripped.values()];
  }

  isTripped(id: BreakerId): boolean {
    return this.tripped.has(id);
  }

  get emergency(): BreakerState | undefined {
    return this.tripped.get("EMERGENCY_STOP");
  }

  /** Breakers other than the emergency stop. */
  others(): BreakerState[] {
    return this.list().filter((b) => b.id !== "EMERGENCY_STOP");
  }

  trip(id: BreakerId, reason: string, now: number, manualReset = true): BreakerChange | null {
    if (this.tripped.has(id)) return null;
    const b: BreakerState = { id, reason, since: now, manualReset };
    this.tripped.set(id, b);
    return { kind: "tripped", breaker: b };
  }

  /** Manual re-activation. Returns the breakers that were cleared. */
  reset(ids: BreakerId[] | "all"): BreakerState[] {
    const cleared: BreakerState[] = [];
    for (const b of this.list()) {
      if (ids === "all" || ids.includes(b.id)) {
        this.tripped.delete(b.id);
        cleared.push(b);
      }
    }
    return cleared;
  }

  evaluate(i: BreakerInputs): BreakerChange[] {
    const out: BreakerChange[] = [];
    const push = (c: BreakerChange | null) => c && out.push(c);
    if (!i.feedHealthy) push(this.trip("STALE_DATA", `données obsolètes : ${i.feedReason ?? "?"}`, i.now, false));
    else {
      const b = this.tripped.get("STALE_DATA");
      if (b) {
        this.tripped.delete("STALE_DATA");
        out.push({ kind: "recovered", breaker: b });
      }
    }
    if (i.lossUsed24h >= i.maxDailyLoss) push(this.trip("DAILY_LOSS", `perte 24 h ${i.lossUsed24h.toFixed(2)} ≥ ${i.maxDailyLoss}`, i.now));
    if (i.lossUsed7d >= i.maxWeeklyLoss) push(this.trip("WEEKLY_LOSS", `perte 7 j ${i.lossUsed7d.toFixed(2)} ≥ ${i.maxWeeklyLoss}`, i.now));
    if (i.consecutiveErrors >= i.maxConsecutiveErrors) push(this.trip("API_ERRORS", `${i.consecutiveErrors} erreurs consécutives`, i.now));
    if (i.executionRejectionsLastHour >= i.maxExecutionRejectionsPerHour)
      push(this.trip("EXECUTION_REJECTIONS", `${i.executionRejectionsLastHour} ordres non exécutés en 1 h`, i.now));
    // Defense in depth: the Risk Engine should make this impossible.
    if (i.fillsLastHour > i.maxTradesPerHour * 2) push(this.trip("TRADE_RATE", `nombre anormal d'exécutions : ${i.fillsLastHour} en 1 h`, i.now));
    return out;
  }
}

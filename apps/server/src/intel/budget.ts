/**
 * API call budget: monthly quota (CoinGecko Demo = 10 000 calls/month) and a
 * per-minute ceiling. The allowed hourly rate is recomputed from what is
 * left, so the quota lasts until the end of the (UTC) month.
 */
export interface BudgetState {
  month: string;
  used: number;
}

const monthKey = (now: number) => new Date(now).toISOString().slice(0, 7);
const hoursLeftInMonth = (now: number) => {
  const d = new Date(now);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.max(1, (end - now) / 3_600_000);
};

export class CallBudget {
  private readonly minute: number[] = [];
  private state: BudgetState;

  constructor(
    private monthly: number,
    private perMinute: number,
    state: BudgetState | null,
    now: number,
    /** Safety margin: only this share of the remaining quota is planned. */
    private readonly safety = 0.9,
  ) {
    this.state = state && state.month === monthKey(now) ? { ...state } : { month: monthKey(now), used: 0 };
  }

  setLimits(monthly: number, perMinute: number) {
    this.monthly = monthly;
    this.perMinute = perMinute;
  }

  private roll(now: number) {
    const m = monthKey(now);
    if (m !== this.state.month) this.state = { month: m, used: 0 };
  }

  remaining(now: number): number {
    this.roll(now);
    return Math.max(0, this.monthly - this.state.used);
  }

  /** Calls per hour that keep the quota alive until the end of the month. */
  allowedPerHour(now: number): number {
    return (this.remaining(now) * this.safety) / hoursLeftInMonth(now);
  }

  /** Take one call from the budget; false = must not call now. */
  tryAcquire(now: number): boolean {
    this.roll(now);
    if (this.state.used >= this.monthly) return false;
    while (this.minute.length && (this.minute[0] as number) <= now - 60_000) this.minute.shift();
    if (this.minute.length >= this.perMinute) return false;
    this.minute.push(now);
    this.state.used++;
    return true;
  }

  export(): BudgetState {
    return { ...this.state };
  }

  view(now: number) {
    this.roll(now);
    return {
      month: this.state.month,
      used: this.state.used,
      monthly: this.monthly,
      remaining: this.remaining(now),
      allowedPerHour: Math.round(this.allowedPerHour(now) * 10) / 10,
      lastMinute: this.minute.filter((t) => t > now - 60_000).length,
      perMinute: this.perMinute,
    };
  }
}

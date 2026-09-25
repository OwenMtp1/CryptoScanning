import { SignalEngine, type Opportunity, type RadarSnapshot, type Signal, type SignalConfig } from "@radar/core";
import type { LogFn } from "../market-data/source.js";
import type { MarketDataEngine } from "../market-data/market-data-engine.js";

type Listener = (s: RadarSnapshot) => void;

const MAX_SIGNALS = 1000;
const MAX_EXPIRED = 200;

/**
 * Periodically evaluates market metrics with the Signal Engine and keeps
 * the latest radar snapshot, recent signals and opportunities.
 */
export class RadarService {
  readonly engine: SignalEngine;
  private timer: ReturnType<typeof setInterval> | null = null;
  private latest: RadarSnapshot | null = null;
  private readonly signals: Signal[] = [];
  private readonly expired: Opportunity[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly market: MarketDataEngine,
    config: SignalConfig,
    private readonly log: LogFn,
    private readonly intervalMs: number,
  ) {
    this.engine = new SignalEngine(config);
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): RadarSnapshot {
    const health = this.market.health();
    const evaluatedAt = this.market.evaluationTime();
    const r = this.engine.evaluate(this.market.metrics(), evaluatedAt, { feedHealthy: health.healthy });

    for (const s of r.newSignals) {
      this.signals.push(s);
      this.log({
        type: "SIGNAL_DETECTED",
        level: s.type === "LIQUIDITY_WARNING" ? "warn" : "info",
        productId: s.productId,
        message: `${s.type}${s.window ? ` [${s.window}]` : ""} — ${s.message} (score ${s.score})`,
        data: { signalType: s.type, window: s.window, value: s.value, threshold: s.threshold, score: s.score },
      });
    }
    if (this.signals.length > MAX_SIGNALS) this.signals.splice(0, this.signals.length - MAX_SIGNALS);

    for (const o of r.opened) {
      this.log({
        type: "OPPORTUNITY_DETECTED",
        level: "info",
        productId: o.productId,
        success: o.tradable,
        message: `${o.productId} score ${o.score} — ${o.tradable ? "liquidité OK" : `NON TRADABLE : ${o.liquidityIssues.join(", ")}`} — ${o.suggestedAction}`,
        data: { opportunityId: o.id, score: o.score, scores: o.scores, price: o.price, reasons: o.reasons, signals: o.signals },
      });
    }
    for (const o of r.expired) {
      this.expired.push(o);
      const move = ((o.price - o.priceAtDetection) / o.priceAtDetection) * 100;
      this.log({
        type: "OPPORTUNITY_EXPIRED",
        level: "info",
        productId: o.productId,
        message: `${o.productId} opportunité expirée (score max ${o.peakScore}, prix ${move >= 0 ? "+" : ""}${move.toFixed(2)} % depuis la détection)`,
        data: { opportunityId: o.id, peakScore: o.peakScore, movePct: move },
      });
    }
    if (this.expired.length > MAX_EXPIRED) this.expired.splice(0, this.expired.length - MAX_EXPIRED);

    const since = evaluatedAt - 5 * 60_000;
    let signalsLast5m = 0;
    for (let i = this.signals.length - 1; i >= 0 && (this.signals[i] as Signal).ts >= since; i--) signalsLast5m++;

    const snap: RadarSnapshot = {
      ts: Date.now(),
      evaluatedAt,
      mode: "RADAR",
      health,
      rows: r.rows,
      opportunities: this.engine.activeOpportunities().length,
      signalsLast5m,
    };
    this.latest = snap;
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {
        // ignore listener failures
      }
    }
    return snap;
  }

  snapshot(): RadarSnapshot | null {
    return this.latest;
  }

  recentSignals(limit = 200): Signal[] {
    return this.signals.slice(-limit).reverse();
  }

  opportunities(): { active: Opportunity[]; recent: Opportunity[] } {
    return {
      active: this.engine.activeOpportunities().sort((a, b) => b.score - a.score),
      recent: this.expired.slice(-50).reverse(),
    };
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

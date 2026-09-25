/**
 * Signal Engine — deterministic detection of abnormal moves ("bumps").
 *
 * Input: per-product metrics. Output: radar rows, new signals and
 * opportunity lifecycle changes. No I/O, no clock: `now` is passed in.
 * The engine never places orders; opportunities are observations only.
 */
import type { ProductMetrics } from "../market/state.js";
import { WINDOWS, type SignalConfig, type WindowKey } from "./config.js";
import { assessLiquidity, scoreMetrics, type LiquidityAssessment, type ScoreBreakdown } from "./scoring.js";

export type SignalType = "PRICE_SURGE" | "PRICE_DROP" | "VOLUME_SPIKE" | "ACCELERATION" | "LIQUIDITY_WARNING";

export interface Signal {
  id: string;
  ts: number;
  productId: string;
  type: SignalType;
  window: WindowKey | null;
  /** Measured value (change %, volume ratio, acceleration %…). */
  value: number;
  threshold: number;
  score: number;
  message: string;
}

export type RadarLevel = "none" | "watch" | "alert" | "opportunity";

export interface RadarRow {
  metrics: ProductMetrics;
  scores: ScoreBreakdown;
  liquidity: LiquidityAssessment;
  /** Signal types whose condition is currently true. */
  activeSignals: SignalType[];
  level: RadarLevel;
}

export interface Opportunity {
  id: string;
  productId: string;
  status: "active" | "expired";
  detectedAt: number;
  updatedAt: number;
  expiredAt: number | null;
  priceAtDetection: number;
  price: number;
  score: number;
  peakScore: number;
  scores: ScoreBreakdown;
  tradable: boolean;
  liquidityIssues: string[];
  reasons: string[];
  signals: SignalType[];
  metrics: ProductMetrics;
  /** Phase 1: the radar only observes. */
  suggestedAction: string;
}

export interface EvaluationResult {
  rows: RadarRow[];
  newSignals: Signal[];
  opened: Opportunity[];
  expired: Opportunity[];
}

export interface SignalEngineOptions {
  idFactory?: (prefix: string) => string;
}

const fmt = (x: number, d = 2) => (x > 0 ? "+" : "") + x.toFixed(d);

interface Condition {
  type: SignalType;
  window: WindowKey | null;
  value: number;
  threshold: number;
  message: string;
}

export class SignalEngine {
  private readonly lastEmitted = new Map<string, number>();
  private readonly active = new Map<string, Opportunity>();
  private readonly belowSince = new Map<string, number>();
  private readonly idFactory: (prefix: string) => string;
  private seq = 0;

  constructor(
    private config: SignalConfig,
    opts: SignalEngineOptions = {},
  ) {
    this.idFactory = opts.idFactory ?? ((p) => `${p}_${Date.now().toString(36)}_${(++this.seq).toString(36)}`);
  }

  updateConfig(config: SignalConfig) {
    this.config = config;
  }

  activeOpportunities(): Opportunity[] {
    return [...this.active.values()];
  }

  /** Current conditions for a product (independent of cooldowns). */
  private conditions(m: ProductMetrics): Condition[] {
    const cfg = this.config;
    const out: Condition[] = [];
    for (const w of WINDOWS) {
      const c = m.changes[w.key];
      const th = cfg.surgeThresholdPct[w.key];
      if (c === null) continue;
      if (c >= th)
        out.push({ type: "PRICE_SURGE", window: w.key, value: c, threshold: th, message: `${fmt(c)} % sur ${w.key} (seuil ${th} %)` });
      else if (c <= -th)
        out.push({ type: "PRICE_DROP", window: w.key, value: c, threshold: -th, message: `${fmt(c)} % sur ${w.key} (seuil -${th} %)` });
    }
    const v = cfg.volume;
    if (m.volumeRatio !== null && m.volumeRatio >= v.spikeRatio && m.tradesRecent >= 3) {
      const src = m.baselineSource === "history" ? "historique local" : "moyenne 24h";
      out.push({
        type: "VOLUME_SPIKE",
        window: null,
        value: m.volumeRatio,
        threshold: v.spikeRatio,
        message: `volume ${m.volumeRatio.toFixed(1)}x la baseline (${src}, fenêtre ${v.recentWindowSec}s)`,
      });
    }
    const last = m.segmentReturnsPct[m.segmentReturnsPct.length - 1];
    if (
      m.accelerationPct !== null &&
      last !== undefined &&
      last > 0 &&
      m.accelerationPct >= cfg.acceleration.minAccelerationPct &&
      m.increasingSegments >= 2
    ) {
      out.push({
        type: "ACCELERATION",
        window: null,
        value: m.accelerationPct,
        threshold: cfg.acceleration.minAccelerationPct,
        message: `accélération ${fmt(m.accelerationPct)} % (segments ${cfg.acceleration.segmentSec}s : ${m.segmentReturnsPct
          .map((r) => fmt(r))
          .join(" → ")} %)`,
      });
    }
    return out;
  }

  evaluate(metrics: ProductMetrics[], now: number, opts: { feedHealthy: boolean }): EvaluationResult {
    const cfg = this.config;
    const res: EvaluationResult = { rows: [], newSignals: [], opened: [], expired: [] };

    for (const m of metrics) {
      const scores = scoreMetrics(m, cfg);
      const liquidity = assessLiquidity(m, cfg);
      // Stale data must never produce signals.
      const conds = opts.feedHealthy && m.price !== null ? this.conditions(m) : [];
      const bullish = conds.some((c) => c.type === "PRICE_SURGE" || c.type === "ACCELERATION" || c.type === "VOLUME_SPIKE");
      if (bullish && !liquidity.tradable) {
        conds.push({
          type: "LIQUIDITY_WARNING",
          window: null,
          value: m.spreadPct ?? Number.NaN,
          threshold: cfg.liquidity.maxSpreadPct,
          message: `mouvement détecté mais liquidité insuffisante : ${liquidity.issues.join(", ")}`,
        });
      }

      for (const c of conds) {
        const key = `${m.productId}:${c.type}:${c.window ?? ""}`;
        const last = this.lastEmitted.get(key);
        if (last !== undefined && now - last < cfg.signalCooldownSec * 1000) continue;
        this.lastEmitted.set(key, now);
        res.newSignals.push({
          id: this.idFactory("sig"),
          ts: now,
          productId: m.productId,
          type: c.type,
          window: c.window,
          value: c.value,
          threshold: c.threshold,
          score: scores.composite,
          message: `${m.productId} : ${c.message}`,
        });
      }

      // Opportunity lifecycle.
      const hasSurge = conds.some((c) => c.type === "PRICE_SURGE");
      const hasVolumeWithMomentum =
        conds.some((c) => c.type === "VOLUME_SPIKE") && (m.changes["1m"] ?? 0) > 0 && scores.momentum > 0;
      const qualifies = opts.feedHealthy && scores.composite >= cfg.opportunity.minScore && (hasSurge || hasVolumeWithMomentum);
      const existing = this.active.get(m.productId);
      const reasons = conds.map((c) => c.message);
      if (liquidity.tradable) reasons.push(`liquidité OK (spread ${m.spreadPct?.toFixed(3)} %)`);

      if (qualifies && m.price !== null) {
        this.belowSince.delete(m.productId);
        if (!existing) {
          const opp: Opportunity = {
            id: this.idFactory("opp"),
            productId: m.productId,
            status: "active",
            detectedAt: now,
            updatedAt: now,
            expiredAt: null,
            priceAtDetection: m.price,
            price: m.price,
            score: scores.composite,
            peakScore: scores.composite,
            scores,
            tradable: liquidity.tradable,
            liquidityIssues: liquidity.issues,
            reasons,
            signals: [...new Set(conds.map((c) => c.type))],
            metrics: m,
            suggestedAction: "Aucune — mode RADAR (observation seule)",
          };
          this.active.set(m.productId, opp);
          res.opened.push(opp);
        } else {
          this.refresh(existing, m, scores, liquidity, reasons, conds, now);
        }
      } else if (existing) {
        if (m.price !== null) this.refresh(existing, m, scores, liquidity, existing.reasons, [], now);
        const floor = cfg.opportunity.minScore - cfg.opportunity.hysteresis;
        if (scores.composite < floor || !opts.feedHealthy) {
          const since = this.belowSince.get(m.productId) ?? now;
          this.belowSince.set(m.productId, since);
          if (now - since >= cfg.opportunity.expireAfterSec * 1000) {
            existing.status = "expired";
            existing.expiredAt = now;
            this.active.delete(m.productId);
            this.belowSince.delete(m.productId);
            res.expired.push(existing);
          }
        } else {
          this.belowSince.delete(m.productId);
        }
      }

      const activeSignals = [...new Set(conds.map((c) => c.type))];
      const level: RadarLevel = this.active.has(m.productId)
        ? "opportunity"
        : bullish
          ? "alert"
          : activeSignals.length > 0
            ? "watch"
            : "none";
      res.rows.push({ metrics: m, scores, liquidity, activeSignals, level });
    }

    // Opportunities for products no longer tracked expire immediately.
    const tracked = new Set(metrics.map((m) => m.productId));
    for (const [id, opp] of this.active) {
      if (!tracked.has(id)) {
        opp.status = "expired";
        opp.expiredAt = now;
        this.active.delete(id);
        res.expired.push(opp);
      }
    }
    return res;
  }

  private refresh(
    opp: Opportunity,
    m: ProductMetrics,
    scores: ScoreBreakdown,
    liquidity: LiquidityAssessment,
    reasons: string[],
    conds: Condition[],
    now: number,
  ) {
    opp.updatedAt = now;
    opp.price = m.price ?? opp.price;
    opp.score = scores.composite;
    opp.peakScore = Math.max(opp.peakScore, scores.composite);
    opp.scores = scores;
    opp.tradable = liquidity.tradable;
    opp.liquidityIssues = liquidity.issues;
    opp.reasons = reasons;
    opp.metrics = m;
    for (const c of conds) if (!opp.signals.includes(c.type)) opp.signals.push(c.type);
  }
}

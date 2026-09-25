import { randomUUID } from "node:crypto";
import {
  applyBuyFill,
  applyExitFill,
  applySellFill,
  capitalBreakdown,
  checkExit,
  checkIntent,
  CircuitBreakers,
  computePerformance,
  createPortfolio,
  effectiveStop,
  evaluateConditions,
  findEntryCandidates,
  initializePortfolio,
  inUniverse,
  lossUsed,
  markPosition,
  missingInitialMarks,
  openPosition,
  planRotation,
  StrategySchema,
  strategyRiskIssues,
  Prng,
  simulateMarketOrder,
  toTradeRecord,
  totalValue,
  unrealizedPnl,
  updateMark,
  type BreakerChange,
  type BreakerId,
  type BreakerState,
  type CapitalBreakdown,
  type EquityPoint,
  type Order,
  type OrderIntent,
  type PerformanceStats,
  type PortfolioState,
  type Position,
  type RadarRow,
  type RadarSnapshot,
  type StrategyProposal,
  type StrategyPreview,
  type TradingView,
  type RiskContext,
  type RunMode,
  type RiskDecision,
  type Strategy,
  type TradeRecord,
  type TradingConfig,
} from "@radar/core";
import type { MarketDataEngine } from "../market-data/market-data-engine.js";
import type { LogFn } from "../market-data/source.js";
import type { PaperStateFile, PaperStore } from "./paper-store.js";
import type { StrategyStore } from "./strategy-store.js";

export type TradingMode = RunMode;

export interface TradingServiceOptions {
  mode: TradingMode;
  config: TradingConfig;
  market: MarketDataEngine;
  log: LogFn;
  /** Persistence (PAPER only). */
  store: PaperStore | null;
  /** Strategies edited in the Strategy Builder (overrides config strategies when the file exists). */
  strategyStore?: StrategyStore | null;
  now?: () => number;
  /** Products available to the connected Coinbase account (null = public mode). */
  accountProducts?: () => ReadonlySet<string> | null;
  /** Delayed execution (latency simulation); injectable for tests. */
  schedule?: (fn: () => void, ms: number) => void;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_TRADES_KEPT = 5000;
const MAX_EQUITY_POINTS = 20_000;
const MAX_ORDERS_KEPT = 200;

/**
 * Trading orchestration: Strategy Engine → Risk Engine → Execution → Positions.
 *
 * In RADAR mode the exact same pipeline runs, but approved intents are NOT
 * executed (the portfolio stays virtual). In PAPER mode execution is simulated
 * on the live order book. LIVE is not implemented.
 */
export class TradingService {
  private readonly cfg: TradingConfig;
  private strategies: Strategy[];
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly rng: Prng;
  private portfolio: PortfolioState;
  private positions: Position[] = [];
  private trades: TradeRecord[] = [];
  private equity: EquityPoint[] = [];
  private breakers: CircuitBreakers;
  private readonly pending = new Map<string, Order>();
  private readonly recentOrders: Order[] = [];
  private consecutiveErrors = 0;
  private lastLossAt: number | null = null;
  private entryTimes: number[] = [];
  private fillTimes: number[] = [];
  private executionRejections: number[] = [];
  private lastEntryAt: Record<string, number> = {};
  private readonly lastTriggerAt = new Map<string, number>();
  private rows = new Map<string, RadarRow>();
  private dirty = false;
  private waitingLogged = false;
  private lastEquitySampleAt = 0;
  private feesFromAccount = false;

  constructor(private readonly opts: TradingServiceOptions) {
    this.cfg = opts.config;
    const saved = opts.strategyStore?.load() ?? null;
    this.strategies = saved ?? opts.config.strategies;
    for (const st of this.strategies) {
      const issues = strategyRiskIssues(st, this.cfg.risk);
      if (issues.length) throw new Error(`stratégie ${st.id} invalide : ${issues.join(", ")}`);
    }
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    this.rng = new Prng(this.cfg.paper.seed);
    this.portfolio = createPortfolio(this.cfg.portfolio);
    this.breakers = new CircuitBreakers();
    if (opts.mode === "PAPER" && opts.store) this.restore(opts.store.load());
  }

  get mode(): TradingMode {
    return this.opts.mode;
  }

  get executionEnabled(): boolean {
    return this.opts.mode === "PAPER";
  }

  /** Products the trading layer needs for valuation / rotation. */
  static requiredProducts(cfg: TradingConfig): string[] {
    const cur = cfg.portfolio.currency;
    const assets = new Set([...Object.keys(cfg.portfolio.initial.holdings), ...cfg.strategies.flatMap((s) => Object.keys(s.afterExit.rotation.allocations))]);
    return [...assets].map((a) => `${a}-${cur}`);
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private restore(s: PaperStateFile | null) {
    if (!s) return;
    this.portfolio = s.portfolio;
    // Orders in flight are lost on restart: positions being closed become open again.
    this.positions = s.positions.filter((p) => p.status !== "closed").map((p) => ({ ...p, status: "open" as const }));
    this.trades = s.trades;
    this.equity = s.equity;
    this.breakers = new CircuitBreakers(s.breakers);
    this.consecutiveErrors = s.counters.consecutiveErrors;
    this.lastLossAt = s.counters.lastLossAt;
    this.entryTimes = s.counters.entryTimes;
    this.fillTimes = s.counters.fillTimes;
    this.executionRejections = s.counters.executionRejections;
    this.lastEntryAt = s.lastEntryAt;
  }

  private snapshotState(): PaperStateFile {
    return {
      version: 1,
      savedAt: new Date(this.now()).toISOString(),
      portfolio: this.portfolio,
      positions: this.positions,
      trades: this.trades,
      equity: this.equity,
      breakers: this.breakers.list(),
      counters: {
        consecutiveErrors: this.consecutiveErrors,
        lastLossAt: this.lastLossAt,
        entryTimes: this.entryTimes,
        fillTimes: this.fillTimes,
        executionRejections: this.executionRejections,
      },
      lastEntryAt: this.lastEntryAt,
    };
  }

  private persist() {
    if (!this.dirty || !this.opts.store || this.opts.mode !== "PAPER") return;
    this.dirty = false;
    try {
      this.opts.store.save(this.snapshotState());
    } catch (err) {
      this.opts.log({ type: "API_ERROR", level: "error", success: false, message: `Sauvegarde de l'état paper impossible : ${(err as Error).message}` });
    }
  }

  // ─── Context helpers ──────────────────────────────────────────────────────

  private openPositions(): Position[] {
    return this.positions.filter((p) => p.status !== "closed");
  }

  private prune(now: number) {
    this.entryTimes = this.entryTimes.filter((t) => now - t < DAY);
    this.fillTimes = this.fillTimes.filter((t) => now - t < DAY);
    this.executionRejections = this.executionRejections.filter((t) => now - t < HOUR);
  }

  private realizedSince(since: number): number {
    let s = 0;
    for (let i = this.trades.length - 1; i >= 0; i--) {
      const t = this.trades[i] as TradeRecord;
      if (t.closedAt < since) break;
      s += t.pnl;
    }
    return s;
  }

  private riskContext(intent: OrderIntent, now: number): RiskContext {
    const open = this.openPositions();
    const pendingEntries = [...this.pending.values()].filter((o) => o.intent.kind === "ENTRY");
    const evalTime = this.opts.market.evaluationTime();
    const health = this.opts.market.health();
    const emergency = this.breakers.emergency;
    return {
      now,
      config: this.cfg,
      portfolio: this.portfolio,
      capital: capitalBreakdown(this.portfolio, open, this.cfg.portfolio),
      openPositions: open,
      pendingProductIds: new Set([...this.pending.values()].map((o) => o.intent.productId)),
      accountProducts: this.opts.accountProducts?.() ?? null,
      pendingEntries: { count: pendingEntries.length, quote: pendingEntries.reduce((s, o) => s + (o.intent.quoteSize ?? 0), 0) },
      product: this.opts.market.store.getProduct(intent.productId),
      metrics: this.opts.market.store.metrics(intent.productId, evalTime) ?? undefined,
      feed: { healthy: health.healthy, reason: health.reason, state: this.opts.market.status().state },
      emergencyStop: { active: !!emergency, reason: emergency?.reason ?? null },
      trippedBreakers: this.breakers.others().map((b) => ({ id: b.id, reason: b.reason })),
      history: {
        realizedPnl24h: this.realizedSince(now - DAY),
        realizedPnl7d: this.realizedSince(now - 7 * DAY),
        entriesLastHour: this.entryTimes.filter((t) => now - t < HOUR).length,
        entriesLastDay: this.entryTimes.filter((t) => now - t < DAY).length,
        lastLossAt: this.lastLossAt,
        consecutiveErrors: this.consecutiveErrors,
      },
    };
  }

  private strategy(id: string | null): Strategy | undefined {
    return this.strategies.find((s) => s.id === id);
  }

  // ─── Main loop ────────────────────────────────────────────────────────────

  /** Called on every radar evaluation. */
  onSnapshot(snap: RadarSnapshot) {
    const now = this.now();
    this.prune(now);
    this.rows = new Map(snap.rows.map((r) => [r.metrics.productId, r]));
    const cur = this.cfg.portfolio.currency.toUpperCase();
    for (const r of snap.rows) {
      const m = r.metrics;
      if (m.price !== null && m.quoteCurrency.toUpperCase() === cur) updateMark(this.portfolio, m.baseCurrency, m.price, now);
    }

    if (!this.portfolio.initialized) {
      if (initializePortfolio(this.portfolio, this.cfg.portfolio, now)) {
        this.dirty = true;
        this.opts.log({
          type: "PAPER_INITIALIZED",
          level: "info",
          success: true,
          message: `Portefeuille ${this.executionEnabled ? "paper" : "virtuel (RADAR)"} initialisé : ${totalValue(this.portfolio).toFixed(2)} ${cur} (protégé ${this.cfg.portfolio.protectedCapital})`,
          data: { cash: this.portfolio.cash, holdings: this.portfolio.holdings },
        });
      } else {
        if (!this.waitingLogged) {
          this.waitingLogged = true;
          this.opts.log({ type: "PAPER_INITIALIZED", level: "warn", success: false, message: `En attente des prix pour initialiser le portefeuille : ${missingInitialMarks(this.portfolio, this.cfg.portfolio).join(", ")}` });
        }
        return;
      }
    }

    this.manageExits(now);
    this.evaluateBreakers(now);
    this.evaluateEntries(now);
    this.sampleEquity(now);
    this.persist();
  }

  private manageExits(now: number) {
    for (const p of this.openPositions()) {
      const r = this.rows.get(p.productId);
      const price = r?.metrics.price ?? null;
      if (price !== null && p.status === "open") {
        const before = p.highestPrice;
        markPosition(p, price, now);
        if (p.highestPrice !== before) this.dirty = true;
      }
      if (p.status !== "open" || [...this.pending.values()].some((o) => o.intent.productId === p.productId)) continue;
      const reason = checkExit(p, now);
      if (!reason) continue;
      if (reason === "STOP_LOSS" || reason === "TRAILING_STOP") {
        this.opts.log({
          type: "STOP_TRIGGERED",
          level: "warn",
          productId: p.productId,
          strategy: p.strategyId,
          message: `${p.productId} ${reason === "TRAILING_STOP" ? "trailing stop" : "stop loss"} : prix ${p.lastPrice} ≤ ${effectiveStop(p).toFixed(6)} (entrée ${p.entryPrice.toFixed(6)}, plus haut ${p.highestPrice})`,
          data: { positionId: p.id, entryPrice: p.entryPrice, highestPrice: p.highestPrice, stopLevel: p.stopLevel, trailingLevel: p.trailingLevel, lastPrice: p.lastPrice, reason },
        });
      }
      this.processIntent({
        id: randomUUID(),
        ts: now,
        kind: "EXIT",
        productId: p.productId,
        side: "SELL",
        quoteSize: null,
        baseSize: p.baseQty,
        strategyId: p.strategyId,
        positionId: p.id,
        referencePrice: p.lastPrice,
        reason: `sortie ${reason}`,
        exitReason: reason,
        signalScore: this.rows.get(p.productId)?.scores.composite ?? null,
      });
    }
  }

  private lossUsed(now: number, window: number) {
    return lossUsed(this.realizedSince(now - window), this.openPositions(), this.cfg);
  }

  private evaluateBreakers(now: number) {
    const health = this.opts.market.health();
    const r = this.cfg.risk;
    const changes = this.breakers.evaluate({
      now,
      feedHealthy: health.healthy,
      feedReason: health.reason,
      lossUsed24h: this.lossUsed(now, DAY),
      lossUsed7d: this.lossUsed(now, 7 * DAY),
      maxDailyLoss: r.maxDailyLossQuote,
      maxWeeklyLoss: r.maxWeeklyLossQuote,
      consecutiveErrors: this.consecutiveErrors,
      maxConsecutiveErrors: r.maxConsecutiveErrors,
      executionRejectionsLastHour: this.executionRejections.length,
      maxExecutionRejectionsPerHour: r.maxExecutionRejectionsPerHour,
      fillsLastHour: this.fillTimes.filter((t) => now - t < HOUR).length,
      maxTradesPerHour: r.maxTradesPerHour,
    });
    this.logBreakerChanges(changes);
  }

  private logBreakerChanges(changes: BreakerChange[]) {
    for (const c of changes) {
      this.dirty = true;
      const b = c.breaker;
      if (c.kind === "tripped")
        this.opts.log({
          type: "BOT_PAUSED",
          level: b.id === "STALE_DATA" ? "warn" : "error",
          success: false,
          message: `🔴 Disjoncteur ${b.id} : ${b.reason}. Nouvelles entrées bloquées${b.manualReset ? " — réactivation manuelle requise" : " jusqu'au retour à la normale"}.`,
          data: { ...b },
        });
      else this.opts.log({ type: "BOT_RESUMED", level: "info", success: true, message: `Disjoncteur ${b.id} levé automatiquement (condition rétablie).`, data: { ...b } });
    }
  }

  private evaluateEntries(now: number) {
    const candidates = findEntryCandidates(this.strategies, [...this.rows.values()]);
    const busy = new Set([...this.openPositions().map((p) => p.productId), ...[...this.pending.values()].map((o) => o.intent.productId)]);
    for (const c of candidates) {
      const id = c.row.metrics.productId;
      if (busy.has(id)) continue; // already in position: nothing to propose
      const key = `${c.strategy.id}:${id}`;
      const lastEntry = this.lastEntryAt[key];
      if (lastEntry !== undefined && now - lastEntry < c.strategy.cooldownPerProductSec * 1000) continue;
      const lastTrigger = this.lastTriggerAt.get(key);
      if (lastTrigger !== undefined && now - lastTrigger < this.cfg.risk.retryAfterRejectSec * 1000) continue;
      this.lastTriggerAt.set(key, now);
      const intent: OrderIntent = {
        id: randomUUID(),
        ts: now,
        kind: "ENTRY",
        productId: id,
        side: "BUY",
        quoteSize: c.strategy.sizing.quoteAmount,
        baseSize: null,
        strategyId: c.strategy.id,
        positionId: null,
        referencePrice: c.row.metrics.price as number,
        reason: c.reason,
        exitReason: null,
        signalScore: c.row.scores.composite,
      };
      this.opts.log({
        type: "STRATEGY_TRIGGERED",
        level: "info",
        productId: id,
        strategy: c.strategy.id,
        message: `${c.strategy.name} → ${id} : ${c.reason}${this.executionEnabled ? "" : " (mode RADAR : aucune exécution)"}`,
        data: { intentId: intent.id, quoteSize: intent.quoteSize, score: intent.signalScore },
      });
      const decision = this.processIntent(intent);
      if (decision.approved) busy.add(id);
    }
  }

  private sampleEquity(now: number) {
    if (now - this.lastEquitySampleAt < this.cfg.equitySampleSec * 1000) return;
    this.lastEquitySampleAt = now;
    const perf = this.performance();
    this.equity.push({ ts: now, total: totalValue(this.portfolio), tradingPnl: perf.tradingPnl });
    if (this.equity.length > MAX_EQUITY_POINTS) this.equity.splice(0, this.equity.length - MAX_EQUITY_POINTS);
    this.dirty = true;
  }

  // ─── Intent → Risk → Execution ────────────────────────────────────────────

  /** Every intent goes through here: there is no other path to execution. */
  processIntent(intent: OrderIntent): RiskDecision {
    const now = this.now();
    const decision = checkIntent(intent, this.riskContext(intent, now));
    const base = { productId: intent.productId, strategy: intent.strategyId ?? undefined };
    this.opts.log({
      type: "RISK_CHECK",
      level: "info",
      ...base,
      success: decision.approved,
      message: `${intent.kind} ${intent.productId} : ${decision.approved ? "APPROVED" : "REJECTED"}`,
      data: { intentId: intent.id, checks: decision.checks },
    });
    if (!decision.approved) {
      this.opts.log({
        type: "ORDER_REJECTED",
        level: "warn",
        ...base,
        success: false,
        message: `ORDER REJECTED ${intent.kind} ${intent.side} ${intent.productId} — ${decision.reasons.join(" ; ")}`,
        data: { intentId: intent.id, kind: intent.kind, stage: "risk", reasons: decision.reasons },
      });
      return decision;
    }
    this.opts.log({
      type: "ORDER_APPROVED",
      level: "info",
      ...base,
      success: true,
      message: `ORDER APPROVED ${intent.kind} ${intent.side} ${intent.productId} ${intent.quoteSize !== null ? `${intent.quoteSize} ${this.cfg.portfolio.currency}` : `${intent.baseSize}`}${this.executionEnabled ? "" : " — non exécuté (mode RADAR)"}`,
      data: { intentId: intent.id, kind: intent.kind, executed: this.executionEnabled },
    });
    if (this.executionEnabled) this.submit(intent, now);
    else if (intent.kind === "ENTRY" && intent.strategyId) this.lastEntryAt[`${intent.strategyId}:${intent.productId}`] = now; // virtual cooldown in RADAR
    return decision;
  }

  private submit(intent: OrderIntent, now: number) {
    const order: Order = { id: randomUUID(), intent, status: "SUBMITTED", submittedAt: now, completedAt: null, fill: null, rejectReason: null };
    this.pending.set(order.id, order);
    const pos = intent.positionId ? this.positions.find((p) => p.id === intent.positionId) : undefined;
    if (pos) pos.status = "closing";
    const [lo, hi] = this.cfg.paper.latencyMs;
    const latency = Math.round(lo + (hi - lo) * this.rng.next());
    this.opts.log({
      type: "ORDER_SUBMITTED",
      level: "info",
      productId: intent.productId,
      strategy: intent.strategyId ?? undefined,
      message: `[PAPER] ordre MARKET ${intent.side} ${intent.productId} soumis (latence simulée ${latency} ms)`,
      data: { orderId: order.id, intentId: intent.id, kind: intent.kind, quoteSize: intent.quoteSize, baseSize: intent.baseSize, referencePrice: intent.referencePrice },
    });
    this.schedule(() => this.complete(order.id, latency), latency);
  }

  private complete(orderId: string, latencyMs: number) {
    const order = this.pending.get(orderId);
    if (!order) return;
    const now = this.now();
    const intent = order.intent;
    const m = this.opts.market.store.metrics(intent.productId, this.opts.market.evaluationTime());
    const product = this.opts.market.store.getProduct(intent.productId);
    const res = simulateMarketOrder(
      order.id,
      intent,
      { bid: m?.bestBid ?? null, ask: m?.bestAsk ?? null, bidQty: m?.bestBidQty ?? null, askQty: m?.bestAskQty ?? null },
      { baseIncrement: product?.baseIncrement ?? null, baseMinSize: product?.baseMinSize ?? null, quoteMinSize: product?.quoteMinSize ?? null },
      this.cfg.paper,
      this.rng,
      now,
      latencyMs,
    );
    this.pending.delete(orderId);
    order.completedAt = now;
    order.status = res.status;
    this.recentOrders.push(order);
    if (this.recentOrders.length > MAX_ORDERS_KEPT) this.recentOrders.shift();
    this.dirty = true;
    const pos = intent.positionId ? this.positions.find((p) => p.id === intent.positionId) : undefined;
    const base = { productId: intent.productId, strategy: intent.strategyId ?? undefined };

    if (!("fill" in res)) {
      order.rejectReason = res.reason;
      this.executionRejections.push(now);
      if (res.status === "REJECTED") this.consecutiveErrors++;
      if (pos) pos.status = "open"; // the exit will be retried
      this.opts.log({
        type: "ORDER_REJECTED",
        level: "warn",
        ...base,
        success: false,
        message: `[PAPER] ordre ${intent.side} ${intent.productId} ${res.status === "UNFILLED" ? "non exécuté" : "refusé"} : ${res.reason}`,
        data: { orderId, stage: "execution", status: res.status, reason: res.reason },
      });
      this.evaluateBreakers(now);
      this.persist();
      return;
    }

    const fill = res.fill;
    order.fill = fill;
    this.consecutiveErrors = 0;
    this.fillTimes.push(now);
    this.opts.log({
      type: fill.partial ? "ORDER_PARTIALLY_FILLED" : "ORDER_FILLED",
      level: "info",
      ...base,
      success: true,
      message: `[PAPER] ${intent.side} ${fill.baseQty} ${intent.productId} @ ${fill.price.toPrecision(8)} (demandé ${fill.requestedPrice}, slippage ${fill.slippagePct.toFixed(3)} %, frais ${fill.fee.toFixed(4)})${fill.partial ? " — exécution partielle" : ""}`,
      data: { ...fill },
    });
    if (fill.slippagePct > this.cfg.risk.maxRealizedSlippagePct) {
      const c = this.breakers.trip("SLIPPAGE", `slippage ${fill.slippagePct.toFixed(2)} % sur ${intent.productId} > ${this.cfg.risk.maxRealizedSlippagePct} %`, now);
      if (c) this.logBreakerChanges([c]);
    }

    const baseCurrency = product?.baseCurrency ?? intent.productId.split("-")[0] ?? intent.productId;
    if (intent.kind === "ENTRY") {
      const strategy = this.strategy(intent.strategyId);
      if (!strategy) return;
      applyBuyFill(this.portfolio, baseCurrency, fill);
      const p = openPosition(randomUUID(), intent, fill, strategy, baseCurrency);
      this.positions.push(p);
      this.entryTimes.push(now);
      this.lastEntryAt[`${strategy.id}:${intent.productId}`] = now;
      this.opts.log({
        type: "POSITION_OPENED",
        level: "info",
        ...base,
        success: true,
        message: `⚡ Position ouverte ${intent.productId} : ${p.costQuote.toFixed(2)} ${this.cfg.portfolio.currency} @ ${p.entryPrice.toPrecision(8)}, stop ${p.stopLevel.toPrecision(8)}${p.trailingLevel !== null ? `, trailing ${strategy.exit.trailingStopPct} %` : ""}`,
        data: { positionId: p.id, entryPrice: p.entryPrice, costQuote: p.costQuote, stopLevel: p.stopLevel, trailingLevel: p.trailingLevel, signalScore: p.entrySignalScore, reason: p.entryReason },
      });
    } else if (intent.kind === "ROTATION") {
      applyBuyFill(this.portfolio, baseCurrency, fill);
    } else if (pos) {
      applySellFill(this.portfolio, baseCurrency, fill);
      const closed = applyExitFill(pos, fill, intent.exitReason ?? "STOP_LOSS", product?.baseMinSize ?? 0);
      if (closed) this.closePosition(pos, now);
    }
    this.evaluateBreakers(now);
    this.persist();
  }

  private closePosition(p: Position, now: number) {
    const trade = toTradeRecord(randomUUID(), p, totalValue(this.portfolio));
    this.trades.push(trade);
    if (this.trades.length > MAX_TRADES_KEPT) this.trades.splice(0, this.trades.length - MAX_TRADES_KEPT);
    this.positions = this.positions.filter((x) => x.id !== p.id);
    if (trade.pnl < 0) this.lastLossAt = now;
    this.opts.log({
      type: "POSITION_CLOSED",
      level: "info",
      productId: p.productId,
      strategy: p.strategyId,
      success: trade.pnl >= 0,
      message: `💰 Position fermée ${p.productId} (${trade.exitReason}) : P&L ${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)} ${this.cfg.portfolio.currency} (${trade.pnlPct.toFixed(2)} %), frais ${trade.fees.toFixed(2)}`,
      data: { ...trade },
    });
    const strategy = this.strategy(p.strategyId);
    if (!strategy) return;
    const plan = planRotation(
      trade,
      strategy,
      this.cfg.portfolio.currency,
      (id) => this.rows.get(id)?.metrics.price ?? null,
      () => randomUUID(),
      now,
    );
    for (const s of plan.skipped)
      this.opts.log({ type: "ROTATION_SKIPPED", level: "info", productId: p.productId, strategy: strategy.id, message: `Rotation vers ${s.asset} ignorée : ${s.reason}` });
    for (const intent of plan.intents) {
      this.opts.log({ type: "ROTATION_PLANNED", level: "info", productId: intent.productId, strategy: strategy.id, message: intent.reason, data: { quoteSize: intent.quoteSize } });
      this.processIntent(intent);
    }
  }

  // ─── Manual controls ──────────────────────────────────────────────────────

  emergencyStop(reason: string) {
    const c = this.breakers.trip("EMERGENCY_STOP", reason || "arrêt manuel", this.now());
    if (!c) return false;
    this.dirty = true;
    this.opts.log({
      type: "BOT_STOPPED",
      level: "error",
      success: true,
      message: `🛑 EMERGENCY STOP : ${c.breaker.reason}. Aucune nouvelle position ne sera ouverte. Les sorties de protection restent actives.`,
      data: { ...c.breaker },
    });
    this.persist();
    return true;
  }

  /** Manual re-activation of manual breakers (including the emergency stop). */
  resume(ids: BreakerId[] | "all"): BreakerState[] {
    const cleared = this.breakers.reset(ids);
    if (cleared.length) {
      this.dirty = true;
      this.opts.log({ type: "BOT_RESUMED", level: "warn", success: true, message: `Réactivation manuelle : ${cleared.map((b) => b.id).join(", ")}`, data: { cleared } });
      this.persist();
    }
    return cleared;
  }

  /** Reset the paper portfolio (no order may be in flight). */
  reset(): { ok: boolean; reason?: string } {
    if (!this.executionEnabled) return { ok: false, reason: "réinitialisation disponible en mode PAPER uniquement" };
    if (this.pending.size > 0) return { ok: false, reason: "des ordres sont en cours d'exécution" };
    const emergency = this.breakers.emergency;
    this.portfolio = createPortfolio(this.cfg.portfolio);
    this.positions = [];
    this.trades = [];
    this.equity = [];
    this.breakers = new CircuitBreakers(emergency ? [emergency] : []);
    this.consecutiveErrors = 0;
    this.lastLossAt = null;
    this.entryTimes = [];
    this.fillTimes = [];
    this.executionRejections = [];
    this.lastEntryAt = {};
    this.lastTriggerAt.clear();
    this.recentOrders.length = 0;
    this.waitingLogged = false;
    this.dirty = true;
    this.opts.log({ type: "PAPER_RESET", level: "warn", success: true, message: "Portefeuille paper réinitialisé (historique effacé, emergency stop conservé)." });
    this.persist();
    return { ok: true };
  }

  /** Real fee tier of the connected account (when paper.feeSource = "account"). */
  applyAccountFees(takerPct: number | null) {
    if (this.cfg.paper.feeSource !== "account" || takerPct === null || takerPct === this.cfg.paper.takerFeePct) return;
    const before = this.cfg.paper.takerFeePct;
    this.cfg.paper.takerFeePct = takerPct;
    this.feesFromAccount = true;
    this.opts.log({ type: "CONFIG_LOADED", level: "info", message: `Frais taker du compte Coinbase appliqués à la simulation : ${takerPct.toFixed(3)} % (au lieu de ${before} %)` });
  }

  // ─── Strategy Builder ─────────────────────────────────────────────────────

  listStrategies(): Strategy[] {
    return this.strategies;
  }

  /** Read-only limits shown in the builder (risk limits are not editable from the UI). */
  strategyLimits() {
    return {
      currency: this.cfg.portfolio.currency,
      maxTradeQuote: this.cfg.risk.maxTradeQuote,
      takerFeePct: this.cfg.paper.takerFeePct,
      mode: this.opts.mode,
    };
  }

  private validate(input: unknown): { ok: true; strategy: Strategy } | { ok: false; issues: string[] } {
    const r = StrategySchema.safeParse(input);
    if (!r.success) return { ok: false, issues: r.error.issues.map((i) => `${i.path.join(".") || "stratégie"} : ${i.message}`) };
    const issues = strategyRiskIssues(r.data, this.cfg.risk);
    return issues.length ? { ok: false, issues } : { ok: true, strategy: r.data };
  }

  private saveStrategies(next: Strategy[]) {
    this.opts.strategyStore?.save(next);
    this.strategies = next;
  }

  /** Create or update (by id). Limits of the Risk Engine cannot be exceeded by a strategy. */
  upsertStrategy(input: unknown): { ok: true; strategy: Strategy; created: boolean } | { ok: false; issues: string[] } {
    const v = this.validate(input);
    if (!v.ok) return v;
    const before = this.strategies.find((s) => s.id === v.strategy.id);
    const next = before ? this.strategies.map((s) => (s.id === v.strategy.id ? v.strategy : s)) : [...this.strategies, v.strategy];
    this.saveStrategies(next);
    this.opts.log({
      type: before ? "STRATEGY_UPDATED" : "STRATEGY_CREATED",
      level: "warn",
      strategy: v.strategy.id,
      success: true,
      message: `Stratégie ${before ? "modifiée" : "créée"} depuis le Strategy Builder : ${v.strategy.name}${v.strategy.enabled ? "" : " (désactivée)"}. Les positions ouvertes gardent leurs règles de sortie.`,
      data: { before: before ?? null, after: v.strategy },
    });
    return { ok: true, strategy: v.strategy, created: !before };
  }

  setStrategyEnabled(id: string, enabled: boolean): { ok: boolean; reason?: string } {
    const st = this.strategies.find((s) => s.id === id);
    if (!st) return { ok: false, reason: "stratégie introuvable" };
    return this.upsertStrategy({ ...st, enabled }).ok ? { ok: true } : { ok: false, reason: "validation impossible" };
  }

  /** Refused while the strategy has open positions or orders in flight. */
  deleteStrategy(id: string): { ok: boolean; reason?: string } {
    const st = this.strategies.find((s) => s.id === id);
    if (!st) return { ok: false, reason: "stratégie introuvable" };
    if (this.openPositions().some((p) => p.strategyId === id) || [...this.pending.values()].some((o) => o.intent.strategyId === id))
      return { ok: false, reason: "des positions ou ordres de cette stratégie sont en cours : désactive-la et attends leur clôture" };
    this.saveStrategies(this.strategies.filter((s) => s.id !== id));
    this.opts.log({ type: "STRATEGY_DELETED", level: "warn", strategy: id, success: true, message: `Stratégie supprimée : ${st.name}`, data: { before: st } });
    return { ok: true };
  }

  /** Evaluate an unsaved strategy against the current market (nothing is stored or executed). */
  previewStrategy(input: unknown): StrategyPreview {
    const v = this.validate(input);
    if (!v.ok) return { valid: false, issues: v.issues, matches: [], closest: [], evaluated: 0 };
    const s = v.strategy;
    const now = this.now();
    const scored = [...this.rows.values()]
      .filter((row) => row.metrics.price !== null && inUniverse(s, row))
      .map((row) => {
        const results = evaluateConditions(s, row);
        return { row, results, passed: results.filter((r) => r.passed).length };
      });
    const toItem = (x: (typeof scored)[number]) => {
      const all = x.passed === x.results.length;
      let risk: { approved: boolean; reasons: string[] } | null = null;
      if (all && this.portfolio.initialized) {
        const d = checkIntent(
          { id: "preview", ts: now, kind: "ENTRY", productId: x.row.metrics.productId, side: "BUY", quoteSize: s.sizing.quoteAmount, baseSize: null, strategyId: s.id, positionId: null, referencePrice: x.row.metrics.price as number, reason: "preview", exitReason: null, signalScore: x.row.scores.composite },
          this.riskContext({ productId: x.row.metrics.productId } as OrderIntent, now),
        );
        risk = { approved: d.approved, reasons: d.reasons };
      }
      return {
        productId: x.row.metrics.productId,
        passed: x.passed,
        total: x.results.length,
        conditions: x.results.map((r) => ({ label: r.label, passed: r.passed, value: r.value })),
        risk,
      };
    };
    const matches = scored.filter((x) => x.passed === x.results.length).map(toItem);
    const closest = scored
      .filter((x) => x.passed < x.results.length)
      .sort((a, b) => b.passed - a.passed || b.row.scores.composite - a.row.scores.composite)
      .slice(0, 8)
      .map(toItem);
    return { valid: true, issues: [], matches, closest, evaluated: scored.length };
  }

  // ─── Views ────────────────────────────────────────────────────────────────

  private performance(): PerformanceStats {
    const unrealized = this.openPositions().reduce((s, p) => s + unrealizedPnl(p), 0);
    return computePerformance(this.trades, unrealized, this.equity);
  }

  view(): TradingView {
    const now = this.now();
    const open = this.openPositions();
    const r = this.cfg.risk;
    const limits = {
      lossUsed24h: this.lossUsed(now, DAY),
      maxDailyLoss: r.maxDailyLossQuote,
      lossUsed7d: this.lossUsed(now, 7 * DAY),
      maxWeeklyLoss: r.maxWeeklyLossQuote,
      entriesLastHour: this.entryTimes.filter((t) => now - t < HOUR).length,
      maxTradesPerHour: r.maxTradesPerHour,
      entriesLastDay: this.entryTimes.filter((t) => now - t < DAY).length,
      maxTradesPerDay: r.maxTradesPerDay,
      openPositions: open.length,
      maxOpenPositions: r.maxOpenPositions,
    };
    const usage = Math.max(limits.lossUsed24h / limits.maxDailyLoss, limits.lossUsed7d / limits.maxWeeklyLoss, limits.openPositions / limits.maxOpenPositions);
    const blocked = this.breakers.list().length > 0;
    return {
      mode: this.opts.mode,
      executionEnabled: this.executionEnabled,
      initialized: this.portfolio.initialized,
      waitingFor: this.portfolio.initialized ? [] : missingInitialMarks(this.portfolio, this.cfg.portfolio),
      capital: capitalBreakdown(this.portfolio, open, this.cfg.portfolio),
      initialValue: this.portfolio.initialValue,
      positions: open.map((p) => ({ ...p, unrealizedPnl: unrealizedPnl(p), effectiveStop: effectiveStop(p), currentScore: this.rows.get(p.productId)?.scores.composite ?? null })),
      pendingOrders: [...this.pending.values()],
      performance: this.performance(),
      breakers: this.breakers.list(),
      emergencyStop: this.breakers.emergency ?? null,
      limits,
      riskLevel: blocked ? "BLOCKED" : usage >= 0.75 ? "HIGH" : usage >= 0.4 ? "MEDIUM" : "LOW",
      strategies: this.strategies,
      fees: {
        takerFeePct: this.cfg.paper.takerFeePct,
        assumption: this.feesFromAccount ? "palier réel de ton compte Coinbase (transaction_summary)" : "hypothèse prudente non vérifiée — connecte ta clé Coinbase ou ajuste selon ton palier",
      },
    };
  }

  tradesList(limit = 200): TradeRecord[] {
    return this.trades.slice(-limit).reverse();
  }

  ordersList(): Order[] {
    return [...this.recentOrders].reverse();
  }

  equityCurve(): EquityPoint[] {
    return this.equity;
  }

  /** What each strategy would do for a product right now (dry-run through the Risk Engine). */
  proposals(productId: string): StrategyProposal[] {
    const row = this.rows.get(productId);
    if (!row) return [];
    const now = this.now();
    const out: StrategyProposal[] = [];
    for (const s of this.strategies) {
      if (!s.enabled || !inUniverse(s, row)) continue;
      const results = evaluateConditions(s, row);
      const all = results.every((r) => r.passed);
      let risk: StrategyProposal["risk"] = null;
      if (all && this.portfolio.initialized && row.metrics.price !== null) {
        const d = checkIntent(
          { id: "dry-run", ts: now, kind: "ENTRY", productId, side: "BUY", quoteSize: s.sizing.quoteAmount, baseSize: null, strategyId: s.id, positionId: null, referencePrice: row.metrics.price, reason: "dry-run", exitReason: null, signalScore: row.scores.composite },
          this.riskContext({ productId } as OrderIntent, now),
        );
        risk = { approved: d.approved, reasons: d.reasons };
      }
      out.push({
        strategyId: s.id,
        strategyName: s.name,
        conditions: results.map((r) => ({ label: r.label, passed: r.passed, value: r.value })),
        allConditionsMet: all,
        quoteAmount: s.sizing.quoteAmount,
        estimatedFees: s.sizing.quoteAmount * (this.cfg.paper.takerFeePct / 100) * 2,
        risk,
        action: !all
          ? "Aucune — conditions de la stratégie non réunies"
          : !risk
            ? "Aucune — portefeuille non initialisé"
            : !risk.approved
              ? "Aucune — refusé par le Risk Engine"
              : this.executionEnabled
                ? `Ouvrir une position de ${s.sizing.quoteAmount} ${this.cfg.portfolio.currency} (PAPER)`
                : `Ouvrirait ${s.sizing.quoteAmount} ${this.cfg.portfolio.currency} — mode RADAR, non exécuté`,
      });
    }
    return out;
  }
}

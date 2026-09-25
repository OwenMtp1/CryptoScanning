/**
 * Risk Engine — the mandatory barrier between intents and execution.
 *
 * Pure and deterministic: all state is passed in the context. Every check
 * is always evaluated (no short-circuit) so a rejection lists ALL the
 * reasons. An intent is approved only if every applicable check passes.
 *
 * Exits are deliberately NOT blocked by loss limits, cooldowns, emergency
 * stop or circuit breakers: blocking a protective exit would increase risk.
 */
import type { ProductMetrics } from "../market/state.js";
import type { FeedConnectionState, Product } from "../market/types.js";
import type { TradingConfig } from "./config.js";
import type { CapitalBreakdown, PortfolioState } from "./portfolio.js";
import { positionValue } from "./portfolio.js";
import { unrealizedPnl } from "./positions.js";
import type { OrderIntent, Position, RiskCheck, RiskCheckName, RiskDecision } from "./types.js";

export interface RiskHistory {
  /** Realized P&L of trades closed in the last 24 h / 7 days (rolling windows). */
  realizedPnl24h: number;
  realizedPnl7d: number;
  entriesLastHour: number;
  entriesLastDay: number;
  lastLossAt: number | null;
  consecutiveErrors: number;
}

export interface RiskContext {
  /** Local clock (ms). */
  now: number;
  config: TradingConfig;
  portfolio: PortfolioState;
  capital: CapitalBreakdown;
  openPositions: Position[];
  /** Products with an order in flight. */
  pendingProductIds: ReadonlySet<string>;
  /** Entry orders in flight (not yet positions) — counted against limits. */
  pendingEntries: { count: number; quote: number };
  product: Product | undefined;
  metrics: ProductMetrics | undefined;
  feed: { healthy: boolean; reason: string | null; state: FeedConnectionState };
  emergencyStop: { active: boolean; reason: string | null };
  trippedBreakers: ReadonlyArray<{ id: string; reason: string }>;
  history: RiskHistory;
}

const f2 = (x: number) => x.toFixed(2);

/** Loss counted against daily/weekly limits: realized P&L + unrealized LOSSES (unrealized gains are ignored). */
export function lossUsed(realized: number, openPositions: Position[], cfg: TradingConfig): number {
  const unrealizedLosses = openPositions.reduce((s, p) => s + Math.min(0, unrealizedPnl(p, p.lastPrice, cfg.paper.takerFeePct)), 0);
  return Math.max(0, -(realized + unrealizedLosses));
}

/** Estimated slippage (%) of a market order vs the reference price: price gap to the touch + size impact. */
export function estimateSlippagePct(intent: OrderIntent, m: ProductMetrics | undefined, cfg: TradingConfig): number | null {
  if (!m || m.bestBid === null || m.bestAsk === null || m.bestBid <= 0 || intent.referencePrice <= 0) return null;
  const buy = intent.side === "BUY";
  const touch = buy ? m.bestAsk : m.bestBid;
  const qty = buy ? m.bestAskQty : m.bestBidQty;
  const gapPct = Math.max(0, ((buy ? touch - intent.referencePrice : intent.referencePrice - touch) / intent.referencePrice) * 100);
  const orderQuote = buy ? (intent.quoteSize ?? 0) : (intent.baseSize ?? 0) * touch;
  const depthQuote = qty !== null ? qty * touch : null;
  if (depthQuote === null || depthQuote <= 0) return null;
  return gapPct + cfg.paper.impactPctPerDepth * (orderQuote / depthQuote);
}

type Add = (name: RiskCheckName, passed: boolean, detail: string) => void;

function marketChecks(intent: OrderIntent, ctx: RiskContext, add: Add, strictData: boolean) {
  const { metrics: m, product: p, config } = ctx;
  const r = config.risk;
  // Data freshness (local receive time of the last message for this product).
  const age = m?.lastReceivedAt != null ? (ctx.now - m.lastReceivedAt) / 1000 : null;
  const maxAge = strictData ? r.maxDataAgeSec : r.maxExitDataAgeSec;
  const feedOk = strictData ? ctx.feed.healthy : true;
  add(
    "data_freshness",
    feedOk && age !== null && age <= maxAge,
    !feedOk
      ? `flux non sain : ${ctx.feed.reason ?? "inconnu"}`
      : age === null
        ? "aucune donnée reçue pour ce produit"
        : `dernière donnée il y a ${age.toFixed(1)} s (max ${maxAge} s)`,
  );
  if (strictData) add("exchange_status", ctx.feed.state === "open", `état de la connexion : ${ctx.feed.state}`);
  // Price sanity.
  const bid = m?.bestBid ?? null;
  const ask = m?.bestAsk ?? null;
  if (bid === null || ask === null || !(bid > 0) || ask < bid) {
    add("price_sanity", false, "bid/ask indisponible ou incohérent");
  } else {
    const mid = (bid + ask) / 2;
    const dev = (Math.abs(intent.referencePrice - mid) / mid) * 100;
    const limit = strictData ? r.maxPriceDeviationPct : Math.max(r.maxPriceDeviationPct, 10);
    add("price_sanity", intent.referencePrice > 0 && dev <= limit, `écart prix de référence / mid ${f2(dev)} % (max ${limit} %)`);
  }
  if (!strictData) return;
  // Market state & liquidity.
  const flags = p?.flags;
  const eligible =
    !!p &&
    p.productType === "SPOT" &&
    p.status.toLowerCase() === "online" &&
    !flags?.tradingDisabled &&
    !flags?.isDisabled &&
    !flags?.cancelOnly &&
    !flags?.viewOnly &&
    !flags?.auctionMode &&
    !flags?.limitOnly &&
    p.quoteCurrency.toUpperCase() === ctx.portfolio.currency.toUpperCase();
  add(
    "product_eligible",
    eligible,
    !p
      ? "produit inconnu"
      : eligible
        ? `${p.productId} SPOT online, coté en ${p.quoteCurrency}`
        : `${p.productId} non éligible (type ${p.productType}, statut ${p.status}, devise ${p.quoteCurrency}${flags?.limitOnly ? ", limit-only" : ""}${flags?.cancelOnly ? ", cancel-only" : ""})`,
  );
  const spread = m?.spreadPct ?? null;
  add("spread", spread !== null && spread <= r.maxSpreadPct, spread === null ? "spread inconnu" : `spread ${spread.toFixed(3)} % (max ${r.maxSpreadPct} %)`);
  const depth = m?.topBookDepthQuote ?? null;
  const vol = m?.volume24hQuote ?? null;
  const liqOk = depth !== null && depth >= r.minTopBookDepthQuote && vol !== null && vol >= r.min24hVolumeQuote;
  add(
    "liquidity",
    liqOk,
    `profondeur ${depth === null ? "inconnue" : Math.round(depth)} (min ${r.minTopBookDepthQuote}), volume 24h ${vol === null ? "inconnu" : Math.round(vol)} (min ${r.min24hVolumeQuote})`,
  );
  const slip = estimateSlippagePct(intent, m, config);
  add(
    "estimated_slippage",
    slip !== null && slip <= r.maxEstimatedSlippagePct,
    slip === null ? "slippage non estimable (carnet indisponible)" : `slippage estimé ${f2(slip)} % (max ${r.maxEstimatedSlippagePct} %)`,
  );
}

function minSizeCheck(intent: OrderIntent, ctx: RiskContext, add: Add) {
  const p = ctx.product;
  const ask = ctx.metrics?.bestAsk ?? intent.referencePrice;
  const quote = intent.quoteSize ?? (intent.baseSize ?? 0) * intent.referencePrice;
  const base = intent.baseSize ?? (ask > 0 ? quote / ask : 0);
  const qMin = p?.quoteMinSize ?? null;
  const bMin = p?.baseMinSize ?? null;
  const ok = quote > 0 && (qMin === null || quote >= qMin) && (bMin === null || base >= bMin);
  add("min_order_size", ok, `montant ${f2(quote)} (min ${qMin ?? "?"}), quantité ${base.toPrecision(6)} (min ${bMin ?? "?"})`);
}

function blockingChecks(ctx: RiskContext, add: Add) {
  add("emergency_stop", !ctx.emergencyStop.active, ctx.emergencyStop.active ? `EMERGENCY STOP actif${ctx.emergencyStop.reason ? ` : ${ctx.emergencyStop.reason}` : ""}` : "inactif");
  add(
    "circuit_breakers",
    ctx.trippedBreakers.length === 0,
    ctx.trippedBreakers.length === 0 ? "aucun disjoncteur déclenché" : `disjoncteur(s) : ${ctx.trippedBreakers.map((b) => `${b.id} (${b.reason})`).join(", ")}`,
  );
}

function entryChecks(intent: OrderIntent, ctx: RiskContext, add: Add) {
  const r = ctx.config.risk;
  const q = intent.quoteSize ?? 0;
  const cap = ctx.capital;
  const pend = ctx.pendingEntries;
  blockingChecks(ctx, add);
  marketChecks(intent, ctx, add, true);
  add("max_trade_size", q > 0 && q <= r.maxTradeQuote, `montant ${f2(q)} (max ${r.maxTradeQuote})`);
  minSizeCheck(intent, ctx, add);
  add(
    "capital_available",
    q + pend.quote <= cap.available + 1e-9,
    `montant ${f2(q)}${pend.quote > 0 ? ` + ${f2(pend.quote)} en cours` : ""}, capital disponible ${f2(cap.available)} (liquidités ${f2(cap.cash)})`,
  );
  const headroom = cap.tradable - cap.engaged - pend.quote - q;
  add(
    "protected_capital",
    headroom >= -1e-9,
    `après l'ordre : total ${f2(cap.total)} − protégé ${f2(cap.protected)} − engagé ${f2(cap.engaged + pend.quote + q)} = ${f2(headroom)} (doit rester ≥ 0)`,
  );
  const nPos = ctx.openPositions.length + pend.count;
  add("max_positions", nPos < r.maxOpenPositions, `${ctx.openPositions.length} position(s) ouverte(s)${pend.count ? ` + ${pend.count} en cours` : ""} (max ${r.maxOpenPositions})`);
  const base = ctx.product?.baseCurrency ?? intent.productId.split("-")[0];
  const assetExp = ctx.openPositions.filter((p) => p.baseCurrency === base).reduce((s, p) => s + positionValue(ctx.portfolio, p), 0);
  add("exposure_asset", assetExp + q <= r.maxExposurePerAssetQuote + 1e-9, `exposition ${base} ${f2(assetExp + q)} après l'ordre (max ${r.maxExposurePerAssetQuote})`);
  const totalExp = cap.engaged + pend.quote + q;
  add("exposure_total", totalExp <= r.maxTotalExposureQuote + 1e-9, `exposition totale ${f2(totalExp)} après l'ordre (max ${r.maxTotalExposureQuote})`);
  const day = lossUsed(ctx.history.realizedPnl24h, ctx.openPositions, ctx.config);
  add("daily_loss", day < r.maxDailyLossQuote, `perte 24 h ${f2(day)} (limite ${r.maxDailyLossQuote})`);
  const week = lossUsed(ctx.history.realizedPnl7d, ctx.openPositions, ctx.config);
  add("weekly_loss", week < r.maxWeeklyLossQuote, `perte 7 j ${f2(week)} (limite ${r.maxWeeklyLossQuote})`);
  const h = ctx.history;
  add(
    "trade_count",
    h.entriesLastHour < r.maxTradesPerHour && h.entriesLastDay < r.maxTradesPerDay,
    `${h.entriesLastHour} trade(s)/h (max ${r.maxTradesPerHour}), ${h.entriesLastDay}/24 h (max ${r.maxTradesPerDay})`,
  );
  const since = h.lastLossAt === null ? null : (ctx.now - h.lastLossAt) / 1000;
  add(
    "cooldown_after_loss",
    since === null || since >= r.cooldownAfterLossSec,
    since === null ? "aucune perte récente" : `dernière perte il y a ${Math.round(since)} s (cooldown ${r.cooldownAfterLossSec} s)`,
  );
  add("previous_errors", h.consecutiveErrors < r.maxConsecutiveErrors, `${h.consecutiveErrors} erreur(s) consécutive(s) (max ${r.maxConsecutiveErrors - 1})`);
  const dup = ctx.openPositions.some((p) => p.productId === intent.productId) || ctx.pendingProductIds.has(intent.productId);
  add("duplicate_position", !dup, dup ? `position ou ordre déjà en cours sur ${intent.productId}` : "aucune position sur ce produit");
}

function rotationChecks(intent: OrderIntent, ctx: RiskContext, add: Add) {
  const q = intent.quoteSize ?? 0;
  blockingChecks(ctx, add);
  marketChecks(intent, ctx, add, true);
  minSizeCheck(intent, ctx, add);
  const reserved = ctx.pendingEntries.quote;
  add("capital_available", q > 0 && q + reserved <= ctx.capital.cash + 1e-9, `montant ${f2(q)}, liquidités ${f2(ctx.capital.cash)}${reserved ? ` (dont ${f2(reserved)} réservés)` : ""}`);
  add("previous_errors", ctx.history.consecutiveErrors < ctx.config.risk.maxConsecutiveErrors, `${ctx.history.consecutiveErrors} erreur(s) consécutive(s)`);
  add("duplicate_position", !ctx.pendingProductIds.has(intent.productId), ctx.pendingProductIds.has(intent.productId) ? "ordre déjà en cours sur ce produit" : "aucun ordre en cours");
}

function exitChecks(intent: OrderIntent, ctx: RiskContext, add: Add) {
  const pos = ctx.openPositions.find((p) => p.id === intent.positionId);
  const qty = intent.baseSize ?? 0;
  // The bot may only sell what one of its positions holds: core holdings are untouchable.
  add(
    "position_exists",
    !!pos && pos.status === "open" && qty > 0 && qty <= pos.baseQty + 1e-12,
    !pos ? "position introuvable" : `vente ${qty} ≤ quantité de la position ${pos.baseQty} (statut ${pos.status})`,
  );
  add("duplicate_position", !ctx.pendingProductIds.has(intent.productId), ctx.pendingProductIds.has(intent.productId) ? "ordre déjà en cours sur ce produit" : "aucun ordre en cours");
  marketChecks(intent, ctx, add, false);
}

export function checkIntent(intent: OrderIntent, ctx: RiskContext): RiskDecision {
  const checks: RiskCheck[] = [];
  const add: Add = (name, passed, detail) => checks.push({ name, passed, detail });
  if (intent.kind === "ENTRY") {
    if (intent.side !== "BUY") add("product_eligible", false, "une entrée doit être un achat (spot, pas de vente à découvert)");
    entryChecks(intent, ctx, add);
  } else if (intent.kind === "ROTATION") {
    if (intent.side !== "BUY") add("product_eligible", false, "une rotation doit être un achat");
    rotationChecks(intent, ctx, add);
  } else {
    if (intent.side !== "SELL") add("position_exists", false, "une sortie doit être une vente");
    exitChecks(intent, ctx, add);
  }
  const failed = checks.filter((c) => !c.passed);
  return { intentId: intent.id, approved: failed.length === 0, checks, reasons: failed.map((c) => `${c.name}: ${c.detail}`) };
}

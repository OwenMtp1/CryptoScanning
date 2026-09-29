/**
 * Transport-independent API routes, shared by the Node HTTP server and the
 * in-browser demo. No Node-only import here.
 */
import { LogQuerySchema, redact, type LogEvent, type LogQuery, type StatusResponse } from "@radar/core";
import { z } from "zod";
import type { MarketDataEngine } from "../market-data/market-data-engine.js";
import type { RadarService } from "../signal-engine/radar-service.js";
import type { TradingService } from "../trading/trading-service.js";
import type { IntelService } from "../intel/intel-service.js";

export interface LogReader {
  query(q: LogQuery): LogEvent[];
  subscribe(l: (e: LogEvent) => void): () => void;
}

export interface RouteContext {
  log: LogReader;
  market: MarketDataEngine;
  radar: RadarService;
  trading: TradingService;
  /** Coinbase account status (read-only integration), when available. */
  account?: { view(): unknown };
  /** Multi-source intelligence layer (absent when INTEL_ENABLED=false). */
  intel?: IntelService;
  /** Extra, non-secret source details (CoinGecko budget, Binance feed stats…). */
  intelExtras?: () => Record<string, unknown>;
  /** Public, non-secret configuration exposed to the dashboard. */
  publicConfig: () => Record<string, unknown>;
  startedAt: number;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

const ok = (body: unknown): RouteResult => ({ status: 200, body });

export function statusOf(ctx: RouteContext): StatusResponse {
  const snap = ctx.radar.snapshot();
  return {
    mode: ctx.trading.mode,
    startedAt: ctx.startedAt,
    feed: ctx.market.status(),
    health: snap?.health ?? ctx.market.health(),
    products: ctx.market.getProducts().length,
    opportunities: snap?.opportunities ?? 0,
    signalsLast5m: snap?.signalsLast5m ?? 0,
  };
}

const DIRECTIONS = new Set(["bullish", "bearish", "neutral"]);
const SOURCES = new Set(["coinbase", "binance", "coingecko", "trending", "derivatives", "dex", "news"]);
const csvParam = (v: string | null) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
const numParam = (v: string | null) => (v === null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));

function handleIntel(ctx: RouteContext, pathname: string, params: URLSearchParams): RouteResult | null {
  const intel = ctx.intel;
  if (!intel) return { status: 404, body: { error: "intel_disabled" } };
  const dir = params.get("direction");
  const direction = dir && DIRECTIONS.has(dir) ? (dir as "bullish" | "bearish" | "neutral") : undefined;
  const limit = Math.min(2000, Math.max(1, numParam(params.get("limit")) ?? 300));
  if (pathname === "/api/intel/feed") {
    return ok(
      intel.feed({
        direction,
        sources: csvParam(params.get("sources"))?.filter((x) => SOURCES.has(x)) as never,
        kinds: csvParam(params.get("kinds")),
        coin: params.get("coin") ?? undefined,
        minStrength: numParam(params.get("minStrength")),
        since: numParam(params.get("since")),
        limit,
      }),
    );
  }
  if (pathname === "/api/intel/news") return ok(intel.news({ coin: params.get("coin") ?? undefined, direction, limit }));
  if (pathname === "/api/intel/universe") {
    const filter = params.get("filter");
    return ok(
      intel.universe({
        q: params.get("q") ?? undefined,
        sort: params.get("sort") ?? undefined,
        dir: params.get("dir") === "asc" ? "asc" : params.get("dir") === "desc" ? "desc" : undefined,
        offset: numParam(params.get("offset")),
        limit: numParam(params.get("limit")),
        filter: (["all", "binance", "coinbase", "trending", "signaled", "gainers", "losers"].includes(filter ?? "") ? filter : "all") as never,
      }),
    );
  }
  if (pathname.startsWith("/api/intel/coin/")) {
    const sym = decodeURIComponent(pathname.slice("/api/intel/coin/".length));
    if (!/^[A-Za-z0-9._-]{1,20}$/.test(sym)) return { status: 400, body: { error: "invalid_symbol" } };
    return ok(intel.coinDetail(sym));
  }
  if (pathname === "/api/intel/performance") {
    const src = params.get("source");
    return ok(intel.performance({ minStrength: numParam(params.get("minStrength")), source: src && SOURCES.has(src) ? (src as never) : undefined }));
  }
  if (pathname === "/api/intel/sources") return ok(redact(intel.sourcesView(ctx.intelExtras?.() ?? {})));
  if (pathname === "/api/intel/config") return ok(redact(intel.config()));
  return null;
}

/** GET routes (null = unknown path). */
export function handleGet(ctx: RouteContext, pathname: string, params: URLSearchParams): RouteResult | null {
  if (pathname.startsWith("/api/intel/")) return handleIntel(ctx, pathname, params);
  const limitOf = (max: number) => Math.min(max, Math.max(1, Number(params.get("limit") ?? 200) || 200));
  switch (pathname) {
    case "/api/health":
      return ok({ ok: true, uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000) });
    case "/api/status":
      return ok(statusOf(ctx));
    case "/api/radar":
      return ok(ctx.radar.snapshot());
    case "/api/opportunities": {
      const opps = ctx.radar.opportunities();
      const proposals: Record<string, unknown> = {};
      for (const o of [...opps.active, ...opps.recent]) proposals[o.productId] ??= ctx.trading.proposals(o.productId);
      return ok({ ...opps, proposals });
    }
    case "/api/trading":
      return ok(ctx.trading.view());
    case "/api/trading/trades":
      return ok(ctx.trading.tradesList(limitOf(5000)));
    case "/api/trading/orders":
      return ok(ctx.trading.ordersList());
    case "/api/trading/equity":
      return ok(ctx.trading.equityCurve());
    case "/api/account":
      return ok(redact(ctx.account?.view() ?? { configured: false, state: "disabled" }));
    case "/api/strategies":
      return ok({ strategies: ctx.trading.listStrategies(), limits: ctx.trading.strategyLimits() });
    case "/api/signals":
      return ok(ctx.radar.recentSignals(limitOf(1000)));
    case "/api/products":
      return ok({ products: ctx.market.getProducts(), filter: ctx.market.getFilterSummary() });
    case "/api/logs": {
      const q = LogQuerySchema.safeParse(Object.fromEntries(params));
      if (!q.success) return { status: 400, body: { error: "invalid_query", issues: q.error.issues.map((i) => i.message) } };
      return ok(ctx.log.query(q.data));
    }
    case "/api/config":
      return ok(redact(ctx.publicConfig()));
    default:
      return null;
  }
}

const EmergencyBody = z.object({ reason: z.string().max(200).optional() });
const ResumeBody = z.object({
  confirm: z.literal("RESUME"),
  breakers: z.array(z.enum(["EMERGENCY_STOP", "DAILY_LOSS", "WEEKLY_LOSS", "API_ERRORS", "STALE_DATA", "SLIPPAGE", "EXECUTION_REJECTIONS", "TRADE_RATE"])).optional(),
});
const ResetBody = z.object({ confirm: z.literal("RESET") });
const StrategyBody = z.object({ strategy: z.unknown() });
const ToggleBody = z.object({ id: z.string(), enabled: z.boolean() });
const DeleteBody = z.object({ id: z.string(), confirm: z.literal("DELETE") });

/**
 * POST actions: safety controls and Strategy Builder. None of them can
 * place an order, change a risk limit or move funds.
 */
export function handleAction(ctx: RouteContext, pathname: string, body: unknown): RouteResult | Promise<RouteResult> {
  const bad = (e: z.ZodError): RouteResult => ({ status: 400, body: { error: "invalid_body", issues: e.issues.map((i) => i.message) } });
  const t = ctx.trading;
  switch (pathname) {
    case "/api/trading/emergency-stop": {
      const b = EmergencyBody.safeParse(body);
      if (!b.success) return bad(b.error);
      const changed = t.emergencyStop(b.data.reason ?? "arrêt manuel depuis le dashboard");
      return ok({ ok: true, changed, view: t.view() });
    }
    case "/api/trading/resume": {
      const b = ResumeBody.safeParse(body);
      if (!b.success) return bad(b.error);
      return ok({ ok: true, cleared: t.resume(b.data.breakers ?? "all"), view: t.view() });
    }
    case "/api/trading/reset": {
      const b = ResetBody.safeParse(body);
      if (!b.success) return bad(b.error);
      const r = t.reset();
      return { status: r.ok ? 200 : 409, body: r };
    }
    case "/api/strategies/preview": {
      const b = StrategyBody.safeParse(body);
      if (!b.success) return bad(b.error);
      return ok(t.previewStrategy(b.data.strategy));
    }
    case "/api/strategies/save": {
      const b = StrategyBody.safeParse(body);
      if (!b.success) return bad(b.error);
      const r = t.upsertStrategy(b.data.strategy);
      return { status: r.ok ? 200 : 400, body: r };
    }
    case "/api/strategies/toggle": {
      const b = ToggleBody.safeParse(body);
      if (!b.success) return bad(b.error);
      const r = t.setStrategyEnabled(b.data.id, b.data.enabled);
      return { status: r.ok ? 200 : 404, body: r };
    }
    case "/api/intel/discord/test": {
      if (!ctx.intel) return { status: 404, body: { error: "intel_disabled" } };
      return ctx.intel.discordTest().then((r) => ({ status: r.ok ? 200 : 409, body: r }));
    }
    case "/api/strategies/delete": {
      const b = DeleteBody.safeParse(body);
      if (!b.success) return bad(b.error);
      const r = t.deleteStrategy(b.data.id);
      return { status: r.ok ? 200 : 409, body: r };
    }
    default:
      return { status: 404, body: { error: "not_found" } };
  }
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LogQuerySchema, redact, type StatusResponse } from "@radar/core";
import { z } from "zod";
import type { EventLog } from "../logging/event-log.js";
import type { MarketDataEngine } from "../market-data/market-data-engine.js";
import type { RadarService } from "../signal-engine/radar-service.js";
import type { TradingService } from "../trading/trading-service.js";

export interface ApiContext {
  log: EventLog;
  market: MarketDataEngine;
  radar: RadarService;
  trading: TradingService;
  /** Public, non-secret configuration exposed to the dashboard. */
  publicConfig: () => Record<string, unknown>;
  /** Dashboard origins allowed by CORS (exact match). */
  allowedOrigins: string[];
  startedAt: number;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Local HTTP API + Server-Sent Events stream for the dashboard.
 * Secrets never go through here.
 *
 * Mutating endpoints (POST) are limited to safety controls (emergency stop,
 * manual re-activation, paper reset). They require the custom header
 * `x-radar-action: confirm` — which a foreign web page cannot send without a
 * CORS preflight that only allowed origins pass — and, when present, an
 * allowed Origin. No endpoint can place an order, change a limit or move funds.
 */
export function createApiServer(ctx: ApiContext): Server {
  return createServer((req, res) => {
    try {
      handle(ctx, req, res);
    } catch (err) {
      ctx.log.emit({ type: "API_ERROR", level: "error", success: false, message: `API interne : ${(err as Error).message}` });
      if (!res.headersSent) send(res, 500, { error: "internal_error" });
      else res.end();
    }
  });
}

function baseHeaders(ctx: ApiContext, req: IncomingMessage): Record<string, string> {
  const h: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  };
  const origin = req.headers.origin;
  if (origin && ctx.allowedOrigins.includes(origin)) {
    h["access-control-allow-origin"] = origin;
    h.vary = "Origin";
  }
  return h;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function handle(ctx: ApiContext, req: IncomingMessage, res: ServerResponse) {
  const headers = baseHeaders(ctx, req);
  // DNS-rebinding protection: only answer requests addressed to localhost.
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (!LOCAL_HOSTS.has(host)) return send(res, 403, { error: "forbidden_host" }, headers);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...headers,
      "access-control-allow-methods": "GET, POST",
      "access-control-allow-headers": "content-type, x-radar-action",
      "access-control-max-age": "600",
    });
    return res.end();
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST") return void handlePost(ctx, req, res, url.pathname, headers);
  if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" }, headers);

  switch (url.pathname) {
    case "/api/health":
      return send(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000) }, headers);
    case "/api/status":
      return send(res, 200, status(ctx), headers);
    case "/api/radar":
      return send(res, 200, ctx.radar.snapshot(), headers);
    case "/api/opportunities": {
      const opps = ctx.radar.opportunities();
      const proposals: Record<string, unknown> = {};
      for (const o of [...opps.active, ...opps.recent]) proposals[o.productId] ??= ctx.trading.proposals(o.productId);
      return send(res, 200, { ...opps, proposals }, headers);
    }
    case "/api/trading":
      return send(res, 200, ctx.trading.view(), headers);
    case "/api/trading/trades": {
      const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200));
      return send(res, 200, ctx.trading.tradesList(limit), headers);
    }
    case "/api/trading/orders":
      return send(res, 200, ctx.trading.ordersList(), headers);
    case "/api/trading/equity":
      return send(res, 200, ctx.trading.equityCurve(), headers);
    case "/api/signals": {
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200));
      return send(res, 200, ctx.radar.recentSignals(limit), headers);
    }
    case "/api/products":
      return send(res, 200, { products: ctx.market.getProducts(), filter: ctx.market.getFilterSummary() }, headers);
    case "/api/logs": {
      const q = LogQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!q.success) return send(res, 400, { error: "invalid_query", issues: q.error.issues.map((i) => i.message) }, headers);
      return send(res, 200, ctx.log.query(q.data), headers);
    }
    case "/api/config":
      return send(res, 200, redact(ctx.publicConfig()), headers);
    case "/api/stream":
      return stream(ctx, req, res, headers);
    default:
      return send(res, 404, { error: "not_found" }, headers);
  }
}

const MAX_BODY = 4096;

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body_too_large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

const EmergencyBody = z.object({ reason: z.string().max(200).optional() });
const ResumeBody = z.object({
  confirm: z.literal("RESUME"),
  breakers: z.array(z.enum(["EMERGENCY_STOP", "DAILY_LOSS", "WEEKLY_LOSS", "API_ERRORS", "STALE_DATA", "SLIPPAGE", "EXECUTION_REJECTIONS", "TRADE_RATE"])).optional(),
});
const ResetBody = z.object({ confirm: z.literal("RESET") });

async function handlePost(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, pathname: string, headers: Record<string, string>) {
  const origin = req.headers.origin;
  if (origin && !ctx.allowedOrigins.includes(origin)) return send(res, 403, { error: "forbidden_origin" }, headers);
  if (req.headers["x-radar-action"] !== "confirm") return send(res, 403, { error: "missing_action_header" }, headers);
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, { error: "json_required" }, headers);
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (err) {
    return send(res, 400, { error: (err as Error).message }, headers);
  }
  const bad = (e: z.ZodError) => send(res, 400, { error: "invalid_body", issues: e.issues.map((i) => i.message) }, headers);
  switch (pathname) {
    case "/api/trading/emergency-stop": {
      const b = EmergencyBody.safeParse(body);
      if (!b.success) return bad(b.error);
      const changed = ctx.trading.emergencyStop(b.data.reason ?? "arrêt manuel depuis le dashboard");
      return send(res, 200, { ok: true, changed, view: ctx.trading.view() }, headers);
    }
    case "/api/trading/resume": {
      const b = ResumeBody.safeParse(body);
      if (!b.success) return bad(b.error);
      const cleared = ctx.trading.resume(b.data.breakers ?? "all");
      return send(res, 200, { ok: true, cleared, view: ctx.trading.view() }, headers);
    }
    case "/api/trading/reset": {
      const b = ResetBody.safeParse(body);
      if (!b.success) return bad(b.error);
      const r = ctx.trading.reset();
      return send(res, r.ok ? 200 : 409, r, headers);
    }
    default:
      return send(res, 404, { error: "not_found" }, headers);
  }
}

function status(ctx: ApiContext): StatusResponse {
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

function stream(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, headers: Record<string, string>) {
  res.writeHead(200, {
    ...headers,
    "content-type": "text/event-stream; charset=utf-8",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.write("retry: 2000\n\n");
  write("status", status(ctx));
  write("trading", ctx.trading.view());
  const snap = ctx.radar.snapshot();
  if (snap) write("snapshot", snap);

  const offRadar = ctx.radar.subscribe((s) => {
    write("snapshot", s);
    write("status", status(ctx));
    write("trading", ctx.trading.view());
  });
  const offLog = ctx.log.subscribe((e) => {
    if (e.level !== "debug") write("log", e);
  });
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  req.on("close", () => {
    offRadar();
    offLog();
    clearInterval(keepAlive);
  });
}

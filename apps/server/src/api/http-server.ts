import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LogQuerySchema, redact, type StatusResponse } from "@radar/core";
import type { EventLog } from "../logging/event-log.js";
import type { MarketDataEngine } from "../market-data/market-data-engine.js";
import type { RadarService } from "../signal-engine/radar-service.js";

export interface ApiContext {
  log: EventLog;
  market: MarketDataEngine;
  radar: RadarService;
  /** Public, non-secret configuration exposed to the dashboard. */
  publicConfig: () => Record<string, unknown>;
  /** Dashboard origins allowed by CORS (exact match). */
  allowedOrigins: string[];
  startedAt: number;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Local read-only HTTP API + Server-Sent Events stream for the dashboard.
 * Phase 1 exposes no mutating endpoint. Secrets never go through here.
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
    res.writeHead(204, { ...headers, "access-control-allow-methods": "GET", "access-control-max-age": "600" });
    return res.end();
  }
  if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" }, headers);

  const url = new URL(req.url ?? "/", "http://localhost");
  switch (url.pathname) {
    case "/api/health":
      return send(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000) }, headers);
    case "/api/status":
      return send(res, 200, status(ctx), headers);
    case "/api/radar":
      return send(res, 200, ctx.radar.snapshot(), headers);
    case "/api/opportunities":
      return send(res, 200, ctx.radar.opportunities(), headers);
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

function status(ctx: ApiContext): StatusResponse {
  const snap = ctx.radar.snapshot();
  return {
    mode: "RADAR",
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
  const snap = ctx.radar.snapshot();
  if (snap) write("snapshot", snap);

  const offRadar = ctx.radar.subscribe((s) => {
    write("snapshot", s);
    write("status", status(ctx));
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

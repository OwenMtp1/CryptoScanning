import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { EventLog } from "../logging/event-log.js";
import { handleAction, handleGet, statusOf, type RouteContext } from "./routes.js";

export interface ApiContext extends RouteContext {
  log: EventLog;
  /** Dashboard origins allowed by CORS (exact match). */
  allowedOrigins: string[];
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Local HTTP API + Server-Sent Events stream for the dashboard.
 * Secrets never go through here.
 *
 * Mutating endpoints (POST): safety controls (emergency stop, manual
 * re-activation, paper reset) and the Strategy Builder (strategies are
 * always validated against the Risk Engine limits). They require the custom header
 * `x-radar-action: confirm` — which a foreign web page cannot send without a
 * CORS preflight that only allowed origins pass — and, when present, an
 * allowed Origin. No endpoint can place an order, change a risk limit or move funds.
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

  if (url.pathname === "/api/stream") return stream(ctx, req, res, headers);
  const r = handleGet(ctx, url.pathname, url.searchParams);
  return r ? send(res, r.status, r.body, headers) : send(res, 404, { error: "not_found" }, headers);
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
  const r = handleAction(ctx, pathname, body);
  return send(res, r.status, r.body, headers);
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
  write("status", statusOf(ctx));
  write("trading", ctx.trading.view());
  const snap = ctx.radar.snapshot();
  if (snap) write("snapshot", snap);

  const offRadar = ctx.radar.subscribe((s) => {
    write("snapshot", s);
    write("status", statusOf(ctx));
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

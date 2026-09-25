/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultSignalConfig } from "@radar/core";
import { createApiServer } from "../src/api/http-server.js";
import { EventLog } from "../src/logging/event-log.js";
import { MarketDataEngine } from "../src/market-data/market-data-engine.js";
import { SimulatedMarketSource } from "../src/market-data/simulated-source.js";
import { RadarService } from "../src/signal-engine/radar-service.js";
import { TradingService } from "../src/trading/trading-service.js";
import { defaultTradingConfig } from "@radar/core";

let base = "";
let close: () => void;

beforeAll(async () => {
  const log = new EventLog({ dir: null, console: false });
  const emit = (e: Parameters<EventLog["emit"]>[0]) => void log.emit(e);
  const cfg = defaultSignalConfig();
  const market = new MarketDataEngine({ source: new SimulatedMarketSource({ seed: 1, tickMs: 100, log: emit }), config: cfg, log: emit, quoteCurrencies: ["EUR"], maxProducts: 5 });
  await market.loadProducts();
  market.start();
  const radar = new RadarService(market, cfg, emit, 1000);
  const trading = new TradingService({ mode: "RADAR", config: defaultTradingConfig(), market, log: emit, store: null });
  radar.subscribe((s) => trading.onSnapshot(s));
  radar.tick();
  const server = createApiServer({
    log,
    market,
    radar,
    trading,
    allowedOrigins: ["http://localhost:3000"],
    startedAt: Date.now(),
    publicConfig: () => ({ mode: "RADAR", coinbase: { apiSecret: "should-not-leak" } }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => {
    market.stop();
    server.closeAllConnections();
    server.close();
  };
});
afterAll(() => close());

describe("HTTP API", () => {
  it("serves status and radar snapshot in RADAR mode", async () => {
    const st = (await (await fetch(`${base}/api/status`)).json()) as any;
    expect(st).toMatchObject({ mode: "RADAR", products: 5, feed: { source: "simulated" } });
    const snap = (await (await fetch(`${base}/api/radar`)).json()) as any;
    expect(snap.mode).toBe("RADAR");
    expect(snap.rows).toHaveLength(5);
  });

  it("lists only the filtered products", async () => {
    const r = (await (await fetch(`${base}/api/products`)).json()) as any;
    expect(r.products.every((p: { quoteCurrency: string }) => p.quoteCurrency === "EUR")).toBe(true);
    expect(r.filter.rejected.quote_not_allowed).toBeGreaterThan(0);
  });

  it("filters logs and validates the query", async () => {
    const logs = (await (await fetch(`${base}/api/logs?types=PRODUCTS_LOADED`)).json()) as any;
    expect(logs).toHaveLength(1);
    expect((await fetch(`${base}/api/logs?level=nope`)).status).toBe(400);
  });

  it("never exposes secrets in the config endpoint", async () => {
    const text = await (await fetch(`${base}/api/config`)).text();
    expect(text).not.toContain("should-not-leak");
  });

  it("serves the trading view", async () => {
    const v = (await (await fetch(`${base}/api/trading`)).json()) as any;
    expect(v).toMatchObject({ mode: "RADAR", executionEnabled: false });
    expect(v.strategies[0].id).toBe("bump-momentum");
  });

  it("protects POST controls: action header, origin, JSON, schema", async () => {
    const post = (path: string, body: unknown, h: Record<string, string> = {}) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-radar-action": "confirm", ...h }, body: JSON.stringify(body) });
    expect((await fetch(`${base}/api/trading/emergency-stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await post("/api/trading/emergency-stop", {}, { origin: "http://attacker.example" })).status).toBe(403);
    expect((await post("/api/trading/resume", { confirm: "yes" })).status).toBe(400);
    expect((await post("/api/trading/reset", { confirm: "RESET" })).status).toBe(409); // RADAR mode
    const stop = (await (await post("/api/trading/emergency-stop", { reason: "test" }, { origin: "http://localhost:3000" })).json()) as any;
    expect(stop.view.emergencyStop).toMatchObject({ id: "EMERGENCY_STOP", reason: "test" });
    const resumed = (await (await post("/api/trading/resume", { confirm: "RESUME" })).json()) as any;
    expect(resumed.view.emergencyStop).toBeNull();
    expect((await post("/api/nope", {})).status).toBe(404);
  });

  it("Strategy Builder endpoints validate against risk limits", async () => {
    const post = (p: string, body: unknown) =>
      fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-radar-action": "confirm" }, body: JSON.stringify(body) });
    const list = (await (await fetch(`${base}/api/strategies`)).json()) as any;
    expect(list.limits).toMatchObject({ currency: "EUR", maxTradeQuote: 10 });
    const s0 = list.strategies[0];
    expect((await post("/api/strategies/save", { strategy: { ...s0, sizing: { quoteAmount: 99 } } })).status).toBe(400);
    const prev = (await (await post("/api/strategies/preview", { strategy: s0 })).json()) as any;
    expect(prev.valid).toBe(true);
    expect((await post("/api/strategies/toggle", { id: s0.id, enabled: false })).status).toBe(200);
    expect((await post("/api/strategies/delete", { id: s0.id })).status).toBe(400); // confirmation missing
    expect((await post("/api/strategies/toggle", { id: "nope", enabled: true })).status).toBe(404);
    const unauth = await fetch(`${base}/api/strategies/save`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unauth.status).toBe(403);
  });

  it("rejects unknown methods and unknown hosts (DNS rebinding)", async () => {
    expect((await fetch(`${base}/api/status`, { method: "PUT" })).status).toBe(405);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      const req = request(`${base}/api/status`, { headers: { host: "evil.example" } }, (res) => resolve(res.statusCode ?? 0));
      req.end();
    });
    expect(status).toBe(403);
  });

  it("sends CORS headers only to the dashboard origin", async () => {
    const ok = await fetch(`${base}/api/status`, { headers: { origin: "http://localhost:3000" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const other = await fetch(`${base}/api/status`, { headers: { origin: "http://attacker.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("streams snapshots over SSE", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("event: snapshot")) text += new TextDecoder().decode((await reader.read()).value);
    ctrl.abort();
    expect(text).toContain("event: status");
  });
});

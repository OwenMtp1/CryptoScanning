/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultSignalConfig } from "@radar/core";
import { createApiServer } from "../src/api/http-server.js";
import { EventLog } from "../src/logging/event-log.js";
import { MarketDataEngine } from "../src/market-data/market-data-engine.js";
import { SimulatedMarketSource } from "../src/market-data/simulated-source.js";
import { RadarService } from "../src/signal-engine/radar-service.js";

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
  radar.tick();
  const server = createApiServer({
    log,
    market,
    radar,
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

  it("is read-only and rejects unknown hosts (DNS rebinding)", async () => {
    expect((await fetch(`${base}/api/status`, { method: "POST" })).status).toBe(405);
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

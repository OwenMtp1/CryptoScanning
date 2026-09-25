import { describe, expect, it, vi } from "vitest";
import { defaultSignalConfig, type Product } from "@radar/core";
import { MarketDataEngine } from "../src/market-data/market-data-engine.js";
import type { FrameSink, MarketDataSource, SourceStatus } from "../src/market-data/source.js";

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-09-25T10:00:00Z");

class FakeSource implements MarketDataSource {
  readonly kind = "coinbase" as const;
  sink: FrameSink | null = null;
  started: string[] = [];
  constructor(private readonly raw: unknown) {}
  async loadProducts() {
    const { parseProductsPage } = await import("@radar/core");
    const p = parseProductsPage(this.raw);
    return { products: p.products as Product[], invalid: p.invalid };
  }
  start(ids: string[], sink: FrameSink) {
    this.started = ids;
    this.sink = sink;
  }
  stop() {}
  status(): SourceStatus {
    return { source: "coinbase", state: "open", connections: 1, openConnections: 1, subscribedProducts: this.started.length, lastMessageAt: null, reconnects: 0 };
  }
}

function setup() {
  let now = T0;
  const log = vi.fn();
  const source = new FakeSource({
    products: [
      { product_id: "BTC-EUR", product_type: "SPOT", status: "online", quote_currency_id: "EUR", approximate_quote_24h_volume: "100" },
      { product_id: "BTC-GBP", product_type: "SPOT", status: "online", quote_currency_id: "GBP" },
    ],
  });
  const engine = new MarketDataEngine({ source, config: defaultSignalConfig(), log, quoteCurrencies: ["EUR"], maxProducts: 10, now: () => now });
  const frame = (channel: string, seq: number, events: unknown[], t = now) =>
    JSON.stringify({ channel, client_id: "", timestamp: iso(t), sequence_num: seq, events });
  return { engine, source, log, frame, setNow: (t: number) => (now = t), get now() { return now; } };
}

describe("MarketDataEngine", () => {
  it("loads products dynamically and subscribes only the selected ones", async () => {
    const s = setup();
    await s.engine.loadProducts();
    s.engine.start();
    expect(s.source.started).toEqual(["BTC-EUR"]);
    expect(s.log).toHaveBeenCalledWith(expect.objectContaining({ type: "PRODUCTS_LOADED" }));
  });

  it("is unhealthy before any data and when data becomes stale, then recovers", async () => {
    const s = setup();
    await s.engine.loadProducts();
    expect(s.engine.health()).toMatchObject({ healthy: false, reason: "aucune donnée reçue" });
    s.engine.onFrame(s.frame("heartbeats", 0, [{ heartbeat_counter: "1" }]), s.now, "ws1");
    expect(s.engine.health().healthy).toBe(true);
    s.setNow(T0 + 20_000);
    expect(s.engine.health().healthy).toBe(false);
    expect(s.log).toHaveBeenCalledWith(expect.objectContaining({ type: "DATA_STALE" }));
    s.engine.onFrame(s.frame("heartbeats", 1, [{ heartbeat_counter: "2" }]), s.now, "ws1");
    expect(s.engine.health().healthy).toBe(true);
    expect(s.log).toHaveBeenCalledWith(expect.objectContaining({ type: "DATA_RECOVERED" }));
  });

  it("flags heartbeats missing even if other messages flow", async () => {
    const s = setup();
    await s.engine.loadProducts();
    s.engine.onFrame(s.frame("ticker", 0, [{ tickers: [{ product_id: "BTC-EUR", price: "100" }] }]), s.now, "ws1");
    expect(s.engine.health()).toMatchObject({ healthy: false, reason: "heartbeats absents" });
  });

  it("counts sequence gaps per connection and resets on reconnect", async () => {
    const s = setup();
    await s.engine.loadProducts();
    s.engine.onFrame(s.frame("heartbeats", 5, [{}]), s.now, "ws1");
    s.engine.onFrame(s.frame("heartbeats", 6, [{}]), s.now, "ws1");
    s.engine.onFrame(s.frame("heartbeats", 9, [{}]), s.now, "ws1");
    s.engine.onFrame(s.frame("heartbeats", 0, [{}]), s.now, "ws1"); // reconnect
    s.engine.onFrame(s.frame("heartbeats", 0, [{}]), s.now, "ws2");
    expect(s.engine.status().sequenceGaps).toBe(1);
    expect(s.log).toHaveBeenCalledWith(expect.objectContaining({ type: "WS_SEQUENCE_GAP" }));
  });

  it("logs Coinbase error frames and counts invalid items", async () => {
    const s = setup();
    await s.engine.loadProducts();
    s.engine.onFrame(JSON.stringify({ type: "error", message: "rate limit exceeded" }), s.now, "ws1");
    s.engine.onFrame("garbage", s.now, "ws1");
    expect(s.log).toHaveBeenCalledWith(expect.objectContaining({ type: "API_ERROR", level: "error" }));
    expect(s.log).toHaveBeenCalledWith(expect.objectContaining({ type: "WS_DECODE_ERROR" }));
    expect(s.engine.status().decodeErrors).toBe(1);
  });

  it("updates prices from ticker frames and uses the exchange clock", async () => {
    const s = setup();
    await s.engine.loadProducts();
    s.engine.onFrame(s.frame("ticker", 0, [{ tickers: [{ product_id: "BTC-EUR", price: "100", best_bid: "99.9", best_ask: "100.1" }] }], T0 - 2000), s.now, "ws1");
    expect(s.engine.evaluationTime()).toBe(T0 - 2000);
    const m = s.engine.metrics()[0]!;
    expect(m.price).toBe(100);
    expect(m.spreadPct).toBeCloseTo(0.2, 6);
  });
});

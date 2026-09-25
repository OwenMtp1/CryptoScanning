import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoinbaseWsFeed, type WsLike } from "../src/market-data/coinbase-ws.js";

class FakeWs implements WsLike {
  static instances: FakeWs[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: WsLike["onopen"] = null;
  onmessage: WsLike["onmessage"] = null;
  onclose: WsLike["onclose"] = null;
  onerror: WsLike["onerror"] = null;
  constructor(readonly url: string) {
    FakeWs.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(data: string) {
    this.onmessage?.({ data });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

describe("CoinbaseWsFeed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWs.instances = [];
  });
  afterEach(() => vi.useRealTimers());

  const make = (log = vi.fn()) =>
    new CoinbaseWsFeed({
      url: "wss://advanced-trade-ws.coinbase.com",
      productsPerConnection: 2,
      maxSubscribeMsgPerSec: 4,
      watchdogMs: 10_000,
      wsFactory: (u) => new FakeWs(u),
      log,
      now: () => Date.now(),
      random: () => 0.5,
    });

  it("shards products and subscribes heartbeats + channels without any JWT", () => {
    const feed = make();
    feed.start(["A", "B", "C"], { onFrame: () => {} });
    expect(FakeWs.instances).toHaveLength(2);
    const [ws1] = FakeWs.instances as [FakeWs];
    ws1.open();
    vi.advanceTimersByTime(1000);
    const msgs = ws1.sent.map((s) => JSON.parse(s));
    expect(msgs).toEqual([
      { type: "subscribe", product_ids: [], channel: "heartbeats" },
      { type: "subscribe", product_ids: ["A", "B"], channel: "ticker" },
      { type: "subscribe", product_ids: ["A", "B"], channel: "market_trades" },
    ]);
    for (const m of msgs) expect(m).not.toHaveProperty("jwt");
    feed.stop();
  });

  it("rate-limits subscribe messages", () => {
    const feed = make();
    feed.start(["A", "B", "C", "D"], { onFrame: () => {} });
    for (const ws of FakeWs.instances) ws.open();
    vi.advanceTimersByTime(250);
    const total = () => FakeWs.instances.reduce((n, w) => n + w.sent.length, 0);
    expect(total()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(total()).toBe(5);
    feed.stop();
  });

  it("forwards raw frames to the sink", () => {
    const frames: string[] = [];
    const feed = make();
    feed.start(["A"], { onFrame: (raw, _t, id) => frames.push(`${id}:${raw}`) });
    FakeWs.instances[0]!.open();
    FakeWs.instances[0]!.message('{"x":1}');
    expect(frames).toEqual(['ws1:{"x":1}']);
    feed.stop();
  });

  it("reconnects with exponential backoff and resubscribes", () => {
    const log = vi.fn();
    const feed = make(log);
    feed.start(["A"], { onFrame: () => {} });
    FakeWs.instances[0]!.open();
    FakeWs.instances[0]!.drop();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ type: "WS_DISCONNECTED" }));
    vi.advanceTimersByTime(999);
    expect(FakeWs.instances).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(FakeWs.instances).toHaveLength(2);
    FakeWs.instances[1]!.drop();
    vi.advanceTimersByTime(1999);
    expect(FakeWs.instances).toHaveLength(2);
    vi.advanceTimersByTime(2);
    expect(FakeWs.instances).toHaveLength(3);
    FakeWs.instances[2]!.open();
    vi.advanceTimersByTime(1000);
    expect(FakeWs.instances[2]!.sent.length).toBe(3);
    expect(feed.status().reconnects).toBe(2);
    feed.stop();
  });

  it("watchdog closes a silent connection and reconnects", () => {
    const log = vi.fn();
    const feed = make(log);
    feed.start(["A"], { onFrame: () => {} });
    FakeWs.instances[0]!.open();
    vi.advanceTimersByTime(16_000);
    expect(FakeWs.instances[0]!.closed).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ type: "DATA_STALE" }));
    vi.advanceTimersByTime(2000);
    expect(FakeWs.instances.length).toBeGreaterThanOrEqual(2);
    feed.stop();
  });

  it("stop() closes everything and prevents reconnection", () => {
    const feed = make();
    feed.start(["A"], { onFrame: () => {} });
    FakeWs.instances[0]!.open();
    feed.stop();
    FakeWs.instances[0]!.drop();
    vi.advanceTimersByTime(120_000);
    expect(FakeWs.instances).toHaveLength(1);
    expect(feed.status().state).toBe("closed");
  });
});

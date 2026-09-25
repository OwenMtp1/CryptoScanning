import { describe, expect, it } from "vitest";
import { decodeCoinbaseFrame } from "../src/coinbase/decoder.js";
import { parseCoinbaseTime } from "../src/coinbase/time.js";

// Frames shaped as documented for the Advanced Trade WebSocket (fields
// verified against the official SDK types).
const tickerFrame = JSON.stringify({
  channel: "ticker",
  client_id: "",
  timestamp: "2023-02-09T20:30:37.167359596Z",
  sequence_num: 0,
  events: [
    {
      type: "snapshot",
      tickers: [
        {
          type: "ticker",
          product_id: "BTC-USD",
          price: "21932.98",
          volume_24_h: "16038.28770938",
          low_24_h: "21835.29",
          high_24_h: "23011.18",
          low_52_w: "15460",
          high_52_w: "48240",
          price_percent_chg_24_h: "-4.15775596190603",
          best_bid: "21931.98",
          best_bid_quantity: "8000.21",
          best_ask: "21933.98",
          best_ask_quantity: "8038.07770938",
        },
      ],
    },
  ],
});

describe("parseCoinbaseTime", () => {
  it("handles nanosecond precision", () => {
    expect(parseCoinbaseTime("2023-02-09T20:30:37.167359596Z")).toBe(Date.parse("2023-02-09T20:30:37.167Z"));
  });
  it("handles no fraction and offsets", () => {
    expect(parseCoinbaseTime("2023-02-09T20:30:37Z")).toBe(Date.parse("2023-02-09T20:30:37Z"));
    expect(parseCoinbaseTime("2023-02-09T21:30:37.5+01:00")).toBe(Date.parse("2023-02-09T20:30:37.500Z"));
  });
  it("returns NaN on garbage", () => {
    expect(parseCoinbaseTime("yesterday")).toBeNaN();
  });
});

describe("decodeCoinbaseFrame", () => {
  it("decodes ticker frames with numeric conversion", () => {
    const r = decodeCoinbaseFrame(tickerFrame);
    expect(r.issues).toEqual([]);
    expect(r.channel).toBe("ticker");
    expect(r.sequenceNum).toBe(0);
    expect(r.events).toHaveLength(1);
    const e = r.events[0]!;
    expect(e.kind).toBe("ticker");
    if (e.kind !== "ticker") return;
    expect(e.price).toBe(21932.98);
    expect(e.bestBid).toBe(21931.98);
    expect(e.bestAskQty).toBeCloseTo(8038.0777);
    expect(e.exchangeTime).toBe(Date.parse("2023-02-09T20:30:37.167Z"));
  });

  it("decodes market_trades and flags snapshots", () => {
    const r = decodeCoinbaseFrame(
      JSON.stringify({
        channel: "market_trades",
        client_id: "",
        timestamp: "2023-02-09T20:19:35.39625135Z",
        sequence_num: 3,
        events: [
          {
            type: "snapshot",
            trades: [
              { trade_id: "000000000", product_id: "ETH-USD", price: "1260.01", size: "0.3", side: "BUY", time: "2019-08-14T20:42:27.265Z" },
              { trade_id: "bad", product_id: "ETH-USD", price: "-1", size: "0.3", side: "BUY", time: "2019-08-14T20:42:27.265Z" },
            ],
          },
        ],
      }),
    );
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ kind: "trade", tradeId: "000000000", price: 1260.01, size: 0.3, snapshot: true });
    expect(r.issues).toEqual(["invalid trade values"]);
  });

  it("decodes heartbeats and subscriptions", () => {
    const hb = decodeCoinbaseFrame(
      JSON.stringify({
        channel: "heartbeats",
        client_id: "",
        timestamp: "2023-06-23T20:31:56.121961769Z",
        sequence_num: 0,
        events: [{ current_time: "2023-06-23 20:31:56.121961769 +0000 UTC m=+91717.525857105", heartbeat_counter: "3049" }],
      }),
    );
    expect(hb.events[0]).toMatchObject({ kind: "heartbeat", counter: 3049 });

    const sub = decodeCoinbaseFrame(
      JSON.stringify({
        channel: "subscriptions",
        client_id: "",
        timestamp: "2023-02-09T20:32:15.790758381Z",
        sequence_num: 1,
        events: [{ subscriptions: { ticker: ["BTC-USD"] } }],
      }),
    );
    expect(sub.events[0]).toMatchObject({ kind: "subscriptions", subscriptions: { ticker: ["BTC-USD"] } });
  });

  it("decodes error frames", () => {
    const r = decodeCoinbaseFrame(JSON.stringify({ type: "error", message: "failure to subscribe" }));
    expect(r.events[0]).toEqual({ kind: "error", message: "failure to subscribe" });
  });

  it("never throws on malformed input", () => {
    expect(decodeCoinbaseFrame("{not json").issues).toEqual(["invalid JSON frame"]);
    expect(decodeCoinbaseFrame(JSON.stringify({ foo: 1 })).issues[0]).toMatch(/invalid envelope/);
    const badTicker = decodeCoinbaseFrame(
      JSON.stringify({ channel: "ticker", timestamp: "2023-02-09T20:30:37Z", sequence_num: 1, events: [{ tickers: [{ product_id: "X", price: "abc" }] }] }),
    );
    expect(badTicker.events).toEqual([]);
    expect(badTicker.issues).toEqual(["invalid ticker item"]);
  });

  it("ignores unused channels", () => {
    const r = decodeCoinbaseFrame(JSON.stringify({ channel: "l2_data", timestamp: "2023-02-09T20:30:37Z", sequence_num: 1, events: [{}] }));
    expect(r.events).toEqual([]);
    expect(r.issues).toEqual([]);
  });
});

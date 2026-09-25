import {
  WsEnvelopeSchema,
  WsErrorSchema,
  WsHeartbeatEventSchema,
  WsSubscriptionsEventSchema,
  WsTickerEventSchema,
  WsTickerSchema,
  WsTradeSchema,
  WsTradesEventSchema,
} from "./schemas.js";
import { parseCoinbaseTime } from "./time.js";
import type { MarketEvent } from "../market/types.js";

export interface DecodeResult {
  channel: string | null;
  sequenceNum: number | null;
  events: MarketEvent[];
  /** Validation problems for individual items (the rest of the frame is kept). */
  issues: string[];
}

/**
 * Decode one Coinbase Advanced Trade WebSocket frame into normalized events.
 * Never throws: malformed input is reported in `issues`.
 */
export function decodeCoinbaseFrame(raw: string): DecodeResult {
  const result: DecodeResult = { channel: null, sequenceNum: null, events: [], issues: [] };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    result.issues.push("invalid JSON frame");
    return result;
  }

  const err = WsErrorSchema.safeParse(json);
  if (err.success) {
    result.events.push({
      kind: "error",
      message: [err.data.message, err.data.reason].filter(Boolean).join(": ") || "unknown error",
    });
    return result;
  }

  const env = WsEnvelopeSchema.safeParse(json);
  if (!env.success) {
    result.issues.push(`invalid envelope: ${env.error.issues[0]?.message ?? "unknown"}`);
    return result;
  }
  const { channel, sequence_num, timestamp, events } = env.data;
  result.channel = channel;
  result.sequenceNum = sequence_num;
  const exchangeTime = parseCoinbaseTime(timestamp);
  if (!Number.isFinite(exchangeTime)) {
    result.issues.push(`invalid envelope timestamp: ${timestamp}`);
    return result;
  }

  for (const rawEvent of events) {
    switch (channel) {
      case "ticker":
      case "ticker_batch": {
        const ev = WsTickerEventSchema.safeParse(rawEvent);
        if (!ev.success) {
          result.issues.push("invalid ticker event");
          break;
        }
        for (const t of ev.data.tickers) {
          const p = WsTickerSchema.safeParse(t);
          if (!p.success || p.data.price === undefined || p.data.price <= 0) {
            result.issues.push("invalid ticker item");
            continue;
          }
          const d = p.data;
          result.events.push({
            kind: "ticker",
            productId: d.product_id,
            exchangeTime,
            price: d.price as number,
            bestBid: d.best_bid ?? null,
            bestAsk: d.best_ask ?? null,
            bestBidQty: d.best_bid_quantity ?? null,
            bestAskQty: d.best_ask_quantity ?? null,
            volume24hBase: d.volume_24_h ?? null,
            pctChange24h: d.price_percent_chg_24_h ?? null,
            high24h: d.high_24_h ?? null,
            low24h: d.low_24_h ?? null,
          });
        }
        break;
      }
      case "market_trades": {
        const ev = WsTradesEventSchema.safeParse(rawEvent);
        if (!ev.success) {
          result.issues.push("invalid market_trades event");
          break;
        }
        const snapshot = ev.data.type === "snapshot";
        for (const t of ev.data.trades) {
          const p = WsTradeSchema.safeParse(t);
          if (!p.success) {
            result.issues.push("invalid trade item");
            continue;
          }
          const d = p.data;
          const time = parseCoinbaseTime(d.time);
          const price = d.price as number;
          const size = d.size as number;
          if (!Number.isFinite(time) || !(price > 0) || !(size > 0)) {
            result.issues.push("invalid trade values");
            continue;
          }
          result.events.push({
            kind: "trade",
            productId: d.product_id,
            tradeId: d.trade_id,
            exchangeTime: time,
            price,
            size,
            side: d.side,
            snapshot,
          });
        }
        break;
      }
      case "heartbeats": {
        const ev = WsHeartbeatEventSchema.safeParse(rawEvent);
        if (!ev.success) {
          result.issues.push("invalid heartbeat event");
          break;
        }
        const c = ev.data.heartbeat_counter;
        const counter = c === undefined ? null : Number(c);
        result.events.push({
          kind: "heartbeat",
          exchangeTime,
          counter: counter !== null && Number.isFinite(counter) ? counter : null,
        });
        break;
      }
      case "subscriptions": {
        const ev = WsSubscriptionsEventSchema.safeParse(rawEvent);
        if (ev.success) {
          result.events.push({
            kind: "subscriptions",
            exchangeTime,
            subscriptions: ev.data.subscriptions ?? {},
          });
        }
        break;
      }
      default:
        // Channels not used by the radar (candles, l2_data, status…) are ignored.
        break;
    }
  }
  return result;
}

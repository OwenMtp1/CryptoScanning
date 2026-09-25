/**
 * Zod schemas for the Coinbase Advanced Trade public API payloads.
 *
 * Field names verified against the official SDK `coinbase/coinbase-advanced-py`
 * v1.8.4 (coinbase/rest/types/product_types.py, coinbase/websocket/types/*).
 * See docs/00-audit-et-verification-coinbase.md.
 *
 * Coinbase sends numbers as strings. Schemas are deliberately lenient on
 * optional fields (unknown fields are stripped) but strict on the fields the
 * radar relies on.
 */
import { z } from "zod";

/** A decimal sent as a string (or occasionally a number). Empty string → undefined. */
export const decimalString = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    if (v === "") return undefined;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: "custom", message: `not a finite decimal: ${String(v)}` });
      return z.NEVER;
    }
    return n;
  });

const optDecimal = decimalString.optional();
const optBool = z.boolean().optional();
const optString = z.string().optional();

// ─── REST: GET /api/v3/brokerage/market/products ────────────────────────────

export const RestProductSchema = z.object({
  product_id: z.string().min(1),
  price: optDecimal,
  price_percentage_change_24h: optDecimal,
  volume_24h: optDecimal,
  volume_percentage_change_24h: optDecimal,
  base_increment: optDecimal,
  quote_increment: optDecimal,
  quote_min_size: optDecimal,
  quote_max_size: optDecimal,
  base_min_size: optDecimal,
  base_max_size: optDecimal,
  base_name: optString,
  quote_name: optString,
  is_disabled: optBool,
  new: optBool,
  status: optString,
  cancel_only: optBool,
  limit_only: optBool,
  post_only: optBool,
  trading_disabled: optBool,
  auction_mode: optBool,
  product_type: optString,
  quote_currency_id: optString,
  base_currency_id: optString,
  mid_market_price: optDecimal,
  alias: optString,
  alias_to: z.array(z.string()).optional(),
  base_display_symbol: optString,
  quote_display_symbol: optString,
  view_only: optBool,
  price_increment: optDecimal,
  display_name: optString,
  product_venue: optString,
  approximate_quote_24h_volume: optDecimal,
});
export type RestProduct = z.infer<typeof RestProductSchema>;

export const ListProductsResponseSchema = z.object({
  products: z.array(z.unknown()).default([]),
  num_products: z.number().int().optional(),
});

// ─── WebSocket: wss://advanced-trade-ws.coinbase.com ───────────────────────

export const WsEnvelopeSchema = z.object({
  channel: z.string(),
  client_id: z.string().optional(),
  timestamp: z.string(),
  sequence_num: z.number().int(),
  events: z.array(z.unknown()),
});

export const WsTickerSchema = z.object({
  type: optString,
  product_id: z.string().min(1),
  price: decimalString,
  volume_24_h: optDecimal,
  low_24_h: optDecimal,
  high_24_h: optDecimal,
  low_52_w: optDecimal,
  high_52_w: optDecimal,
  price_percent_chg_24_h: optDecimal,
  best_bid: optDecimal,
  best_ask: optDecimal,
  best_bid_quantity: optDecimal,
  best_ask_quantity: optDecimal,
});

export const WsTickerEventSchema = z.object({
  type: optString,
  tickers: z.array(z.unknown()).default([]),
});

export const WsTradeSchema = z.object({
  product_id: z.string().min(1),
  trade_id: z.string(),
  price: decimalString,
  size: decimalString,
  time: z.string(),
  side: z.string(),
});

export const WsTradesEventSchema = z.object({
  type: optString,
  trades: z.array(z.unknown()).default([]),
});

export const WsHeartbeatEventSchema = z.object({
  current_time: optString,
  heartbeat_counter: z.union([z.string(), z.number()]).optional(),
});

export const WsSubscriptionsEventSchema = z.object({
  subscriptions: z.record(z.string(), z.array(z.string())).optional(),
});

/** Error frames are not wrapped in the standard envelope. */
export const WsErrorSchema = z.object({
  type: z.literal("error"),
  message: z.string().optional(),
  reason: z.string().optional(),
});

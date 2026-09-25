/** Normalized market-data types, independent of the Coinbase wire format. */

export interface Product {
  productId: string;
  baseCurrency: string;
  quoteCurrency: string;
  baseName: string;
  displayName: string;
  productType: string;
  status: string;
  price: number | null;
  pctChange24h: number | null;
  volume24hBase: number | null;
  /** Approximate 24h volume in quote currency, as reported by Coinbase. */
  volume24hQuote: number | null;
  baseMinSize: number | null;
  quoteMinSize: number | null;
  baseIncrement: number | null;
  quoteIncrement: number | null;
  priceIncrement: number | null;
  flags: {
    tradingDisabled: boolean;
    isDisabled: boolean;
    cancelOnly: boolean;
    limitOnly: boolean;
    postOnly: boolean;
    viewOnly: boolean;
    auctionMode: boolean;
    isNew: boolean;
  };
  alias: string | null;
  aliasTo: string[];
  /**
   * Whether tradability for the user's account/region was confirmed.
   * Only the authenticated `GET /products?get_tradability_status=true`
   * can confirm this; always false in phase 1 (public data only).
   */
  tradabilityVerified: boolean;
}

export interface TickerEvent {
  kind: "ticker";
  productId: string;
  /** Exchange timestamp (ms since epoch) of the envelope. */
  exchangeTime: number;
  price: number;
  bestBid: number | null;
  bestAsk: number | null;
  bestBidQty: number | null;
  bestAskQty: number | null;
  volume24hBase: number | null;
  pctChange24h: number | null;
  high24h: number | null;
  low24h: number | null;
}

export interface TradeEvent {
  kind: "trade";
  productId: string;
  tradeId: string;
  exchangeTime: number;
  price: number;
  size: number;
  side: string;
  /** True for the historical trades sent in the subscription snapshot. */
  snapshot: boolean;
}

export interface HeartbeatEvent {
  kind: "heartbeat";
  exchangeTime: number;
  counter: number | null;
}

export interface SubscriptionsEvent {
  kind: "subscriptions";
  exchangeTime: number;
  subscriptions: Record<string, string[]>;
}

export interface FeedErrorEvent {
  kind: "error";
  message: string;
}

export type MarketEvent =
  | TickerEvent
  | TradeEvent
  | HeartbeatEvent
  | SubscriptionsEvent
  | FeedErrorEvent;

export type FeedConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface FeedStatus {
  source: "coinbase" | "simulated";
  state: FeedConnectionState;
  connections: number;
  openConnections: number;
  subscribedProducts: number;
  lastMessageAt: number | null;
  lastHeartbeatAt: number | null;
  reconnects: number;
  sequenceGaps: number;
  decodeErrors: number;
}

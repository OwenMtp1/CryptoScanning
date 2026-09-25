import type { FeedStatus, Product } from "@radar/core";
import type { EmitInput } from "../logging/event-log.js";

export interface FrameSink {
  /** One raw frame in the Coinbase WebSocket wire format. */
  onFrame(raw: string, receivedAt: number, connectionId: string): void;
}

export interface ProductsLoadResult {
  products: Product[];
  invalid: number;
}

/**
 * A market-data source. Both the real Coinbase feed and the simulator
 * deliver raw Coinbase-format frames, decoded by the same pipeline.
 */
export interface MarketDataSource {
  readonly kind: FeedStatus["source"];
  loadProducts(): Promise<ProductsLoadResult>;
  start(productIds: string[], sink: FrameSink): void;
  stop(): void;
  status(): SourceStatus;
}

/** Transport-level status; decoding stats are added by the MarketDataEngine. */
export type SourceStatus = Omit<FeedStatus, "lastHeartbeatAt" | "sequenceGaps" | "decodeErrors">;

export type LogFn = (e: EmitInput) => void;

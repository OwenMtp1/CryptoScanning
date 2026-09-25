import { CoinbasePublicRest } from "./coinbase-rest.js";
import { CoinbaseWsFeed, type WsFactory } from "./coinbase-ws.js";
import type { FrameSink, LogFn, MarketDataSource, ProductsLoadResult, SourceStatus } from "./source.js";

export interface CoinbaseSourceOptions {
  restBaseUrl: string;
  restMaxRps: number;
  wsUrl: string;
  productsPerConnection: number;
  maxSubscribeMsgPerSec: number;
  log: LogFn;
  fetchImpl?: typeof fetch;
  wsFactory?: WsFactory;
}

/** Real Coinbase public data: REST for the product list, WebSocket for live data. */
export class CoinbaseMarketSource implements MarketDataSource {
  readonly kind = "coinbase" as const;
  readonly rest: CoinbasePublicRest;
  private readonly ws: CoinbaseWsFeed;

  constructor(opts: CoinbaseSourceOptions) {
    this.rest = new CoinbasePublicRest({ baseUrl: opts.restBaseUrl, maxRps: opts.restMaxRps, log: opts.log, fetchImpl: opts.fetchImpl });
    this.ws = new CoinbaseWsFeed({
      url: opts.wsUrl,
      productsPerConnection: opts.productsPerConnection,
      maxSubscribeMsgPerSec: opts.maxSubscribeMsgPerSec,
      log: opts.log,
      wsFactory: opts.wsFactory,
    });
  }

  async loadProducts(): Promise<ProductsLoadResult> {
    const r = await this.rest.listPublicSpotProducts();
    return { products: r.products, invalid: r.invalid };
  }

  start(productIds: string[], sink: FrameSink) {
    this.ws.start(productIds, sink);
  }

  stop() {
    this.ws.stop();
  }

  status(): SourceStatus {
    return this.ws.status();
  }
}

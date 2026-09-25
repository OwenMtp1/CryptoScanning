import {
  decodeCoinbaseFrame,
  filterRadarProducts,
  MarketStateStore,
  type FeedHealth,
  type FeedStatus,
  type Product,
  type ProductFilterResult,
  type ProductMetrics,
  type SignalConfig,
} from "@radar/core";
import type { LogFn, MarketDataSource } from "./source.js";

export interface MarketDataEngineOptions {
  source: MarketDataSource;
  config: SignalConfig;
  log: LogFn;
  quoteCurrencies: string[];
  maxProducts: number;
  now?: () => number;
}

const THROTTLE_MS = 10_000;

/**
 * Market Data Engine: loads the product universe, decodes frames from the
 * source, maintains market state and monitors data freshness.
 */
export class MarketDataEngine {
  readonly store: MarketStateStore;
  private products: Product[] = [];
  private filter: ProductFilterResult | null = null;
  private lastHeartbeatAt: number | null = null;
  private lastFrameAt: number | null = null;
  private readonly lastSeq = new Map<string, number>();
  private sequenceGaps = 0;
  private decodeErrors = 0;
  private lastThrottledLog = new Map<string, number>();
  private stale = false;
  private readonly now: () => number;

  constructor(private readonly opts: MarketDataEngineOptions) {
    this.store = new MarketStateStore(opts.config);
    this.now = opts.now ?? Date.now;
  }

  get source() {
    return this.opts.source;
  }

  /** Load and filter the product list (dynamic, never hard-coded). */
  async loadProducts(): Promise<ProductFilterResult> {
    const { products, invalid } = await this.opts.source.loadProducts();
    const filter = filterRadarProducts(products, { quoteCurrencies: this.opts.quoteCurrencies, maxProducts: this.opts.maxProducts });
    this.products = filter.selected;
    this.filter = filter;
    this.store.setProducts(filter.selected);
    this.opts.log({
      type: "PRODUCTS_LOADED",
      level: "info",
      success: true,
      message: `${products.length} produits reçus, ${filter.eligibleBeforeCap} éligibles, ${filter.selected.length} suivis (${this.opts.source.kind})`,
      data: { received: products.length, invalid, selected: filter.selected.length, rejected: filter.rejected, quoteCurrencies: this.opts.quoteCurrencies, maxProducts: this.opts.maxProducts },
    });
    return filter;
  }

  start() {
    this.opts.source.start(
      this.products.map((p) => p.productId),
      { onFrame: (raw, receivedAt, connId) => this.onFrame(raw, receivedAt, connId) },
    );
  }

  stop() {
    this.opts.source.stop();
  }

  private throttled(key: string): boolean {
    const t = this.now();
    const last = this.lastThrottledLog.get(key) ?? 0;
    if (t - last < THROTTLE_MS) return true;
    this.lastThrottledLog.set(key, t);
    return false;
  }

  onFrame(raw: string, receivedAt: number, connId: string) {
    this.lastFrameAt = receivedAt;
    const r = decodeCoinbaseFrame(raw);
    if (r.issues.length) {
      this.decodeErrors += r.issues.length;
      if (!this.throttled("decode"))
        this.opts.log({ type: "WS_DECODE_ERROR", level: "warn", success: false, message: `${r.issues.length} élément(s) invalide(s) : ${r.issues[0]}`, data: { connection: connId, total: this.decodeErrors } });
    }
    if (r.sequenceNum !== null) {
      const prev = this.lastSeq.get(connId);
      // A lower number means the connection was re-opened: restart tracking.
      if (prev !== undefined && r.sequenceNum > prev + 1) {
        this.sequenceGaps++;
        if (!this.throttled(`gap:${connId}`))
          this.opts.log({ type: "WS_SEQUENCE_GAP", level: "warn", message: `${connId} séquence ${prev} → ${r.sequenceNum} (messages manqués possibles)`, data: { total: this.sequenceGaps } });
      }
      this.lastSeq.set(connId, r.sequenceNum);
    }
    for (const e of r.events) {
      if (e.kind === "error") {
        this.opts.log({ type: "API_ERROR", level: "error", success: false, message: `Coinbase WebSocket : ${e.message}`, data: { connection: connId } });
        continue;
      }
      if (e.kind === "heartbeat") this.lastHeartbeatAt = receivedAt;
      this.store.apply(e, receivedAt);
    }
  }

  /** Feed health. Stale data must block signals (and, later, any order). */
  health(): FeedHealth {
    const t = this.now();
    const staleMs = this.opts.config.feedStaleAfterSec * 1000;
    const msgAge = this.lastFrameAt === null ? null : t - this.lastFrameAt;
    const hbAge = this.lastHeartbeatAt === null ? null : t - this.lastHeartbeatAt;
    let reason: string | null = null;
    if (msgAge === null) reason = "aucune donnée reçue";
    else if (msgAge > staleMs) reason = `aucun message depuis ${Math.round(msgAge / 1000)} s`;
    else if (hbAge === null || hbAge > staleMs) reason = "heartbeats absents";
    const healthy = reason === null;

    if (!healthy && !this.stale && this.lastFrameAt !== null) {
      this.stale = true;
      this.opts.log({ type: "DATA_STALE", level: "warn", success: false, message: `Données obsolètes : ${reason}. Signaux suspendus.` });
    } else if (healthy && this.stale) {
      this.stale = false;
      this.opts.log({ type: "DATA_RECOVERED", level: "info", success: true, message: "Flux de données rétabli. Signaux réactivés." });
    }
    return { healthy, reason, lastMessageAgeMs: msgAge, lastHeartbeatAgeMs: hbAge };
  }

  /** Time used for metric computation: the exchange clock when known. */
  evaluationTime(): number {
    return this.store.feedClock ?? this.now();
  }

  metrics(): ProductMetrics[] {
    return this.store.allMetrics(this.evaluationTime());
  }

  getProducts(): Product[] {
    return this.products;
  }

  getFilterSummary() {
    return this.filter ? { eligible: this.filter.eligibleBeforeCap, selected: this.filter.selected.length, rejected: this.filter.rejected } : null;
  }

  status(): FeedStatus {
    return {
      ...this.opts.source.status(),
      lastHeartbeatAt: this.lastHeartbeatAt,
      sequenceGaps: this.sequenceGaps,
      decodeErrors: this.decodeErrors,
    };
  }
}

/**
 * Market simulator producing frames in the Coinbase Advanced Trade wire
 * format (REST products payload + WebSocket `ticker`, `market_trades`,
 * `heartbeats`, `subscriptions` frames).
 *
 * The simulated frames go through exactly the same Zod schemas and decoder
 * as real Coinbase data, so the whole pipeline is exercised.
 *
 * Prices and volumes are FICTITIOUS. Scenarios ("pump", "dump"…) are
 * injected on purpose so the Signal Engine can be observed and validated.
 */
import { Prng } from "./prng.js";

export interface SimAsset {
  base: string;
  name: string;
  quote: string;
  price: number;
  volume24hQuote: number;
  spreadBps: number;
  dailyVolPct: number;
  avgTradeQuote: number;
}

export type ScenarioKind = "pump" | "dump" | "illiquid_pump" | "volume_only";

export interface Scenario {
  kind: ScenarioKind;
  productId: string;
  startMs: number;
  durationMs: number;
  /** Target move at the peak, in % (negative for dumps). */
  magnitudePct: number;
  volumeMult: number;
  spreadMult: number;
}

export const DEFAULT_CATALOG: SimAsset[] = [
  { base: "BTC", name: "Bitcoin", quote: "EUR", price: 95_000, volume24hQuote: 180e6, spreadBps: 1, dailyVolPct: 2.5, avgTradeQuote: 600 },
  { base: "ETH", name: "Ethereum", quote: "EUR", price: 3_400, volume24hQuote: 110e6, spreadBps: 1.5, dailyVolPct: 3.5, avgTradeQuote: 400 },
  { base: "SOL", name: "Solana", quote: "EUR", price: 180, volume24hQuote: 45e6, spreadBps: 3, dailyVolPct: 5, avgTradeQuote: 250 },
  { base: "XRP", name: "XRP", quote: "EUR", price: 2.1, volume24hQuote: 40e6, spreadBps: 3, dailyVolPct: 5, avgTradeQuote: 200 },
  { base: "ADA", name: "Cardano", quote: "EUR", price: 0.72, volume24hQuote: 12e6, spreadBps: 5, dailyVolPct: 6, avgTradeQuote: 150 },
  { base: "DOGE", name: "Dogecoin", quote: "EUR", price: 0.21, volume24hQuote: 20e6, spreadBps: 4, dailyVolPct: 7, avgTradeQuote: 150 },
  { base: "AVAX", name: "Avalanche", quote: "EUR", price: 32, volume24hQuote: 8e6, spreadBps: 6, dailyVolPct: 6, avgTradeQuote: 150 },
  { base: "LINK", name: "Chainlink", quote: "EUR", price: 17, volume24hQuote: 9e6, spreadBps: 6, dailyVolPct: 6, avgTradeQuote: 150 },
  { base: "DOT", name: "Polkadot", quote: "EUR", price: 6.5, volume24hQuote: 5e6, spreadBps: 8, dailyVolPct: 6, avgTradeQuote: 120 },
  { base: "LTC", name: "Litecoin", quote: "EUR", price: 95, volume24hQuote: 6e6, spreadBps: 6, dailyVolPct: 4, avgTradeQuote: 150 },
  { base: "UNI", name: "Uniswap", quote: "EUR", price: 9.5, volume24hQuote: 3e6, spreadBps: 10, dailyVolPct: 7, avgTradeQuote: 120 },
  { base: "ATOM", name: "Cosmos", quote: "EUR", price: 6.8, volume24hQuote: 2.5e6, spreadBps: 10, dailyVolPct: 6, avgTradeQuote: 100 },
  { base: "NEAR", name: "NEAR", quote: "EUR", price: 4.9, volume24hQuote: 2e6, spreadBps: 12, dailyVolPct: 7, avgTradeQuote: 100 },
  { base: "APT", name: "Aptos", quote: "EUR", price: 8.2, volume24hQuote: 1.8e6, spreadBps: 12, dailyVolPct: 7, avgTradeQuote: 100 },
  { base: "ARB", name: "Arbitrum", quote: "EUR", price: 0.65, volume24hQuote: 1.5e6, spreadBps: 15, dailyVolPct: 8, avgTradeQuote: 90 },
  { base: "OP", name: "Optimism", quote: "EUR", price: 1.6, volume24hQuote: 1.2e6, spreadBps: 15, dailyVolPct: 8, avgTradeQuote: 90 },
  { base: "PEPE", name: "Pepe", quote: "EUR", price: 0.000011, volume24hQuote: 4e6, spreadBps: 12, dailyVolPct: 12, avgTradeQuote: 80 },
  { base: "SHIB", name: "Shiba Inu", quote: "EUR", price: 0.000019, volume24hQuote: 2e6, spreadBps: 12, dailyVolPct: 9, avgTradeQuote: 80 },
  { base: "BTC", name: "Bitcoin", quote: "USDC", price: 110_000, volume24hQuote: 600e6, spreadBps: 0.5, dailyVolPct: 2.5, avgTradeQuote: 900 },
  { base: "ETH", name: "Ethereum", quote: "USDC", price: 3_950, volume24hQuote: 350e6, spreadBps: 0.8, dailyVolPct: 3.5, avgTradeQuote: 600 },
  { base: "SOL", name: "Solana", quote: "USDC", price: 208, volume24hQuote: 120e6, spreadBps: 1.5, dailyVolPct: 5, avgTradeQuote: 400 },
  { base: "SUI", name: "Sui", quote: "USDC", price: 3.4, volume24hQuote: 30e6, spreadBps: 4, dailyVolPct: 8, avgTradeQuote: 200 },
  // Low-liquidity assets (targets of "illiquid_pump"; should fail the liquidity gate).
  { base: "MICRO", name: "Micro Token (sim)", quote: "EUR", price: 0.042, volume24hQuote: 25_000, spreadBps: 120, dailyVolPct: 15, avgTradeQuote: 8 },
  { base: "THIN", name: "Thin Market (sim)", quote: "EUR", price: 1.35, volume24hQuote: 60_000, spreadBps: 80, dailyVolPct: 12, avgTradeQuote: 10 },
];

/** Products that the product filter must reject (exercise the filter). */
const NON_RADAR_PRODUCTS = [
  { product_id: "BIT-31OCT26-CDE", product_type: "FUTURE", status: "online", quote_currency_id: "USD", base_currency_id: "BIT" },
  { product_id: "OLD-EUR", product_type: "SPOT", status: "offline", quote_currency_id: "EUR", base_currency_id: "OLD" },
  { product_id: "HALT-EUR", product_type: "SPOT", status: "online", trading_disabled: true, quote_currency_id: "EUR", base_currency_id: "HALT" },
  { product_id: "CXL-EUR", product_type: "SPOT", status: "online", cancel_only: true, quote_currency_id: "EUR", base_currency_id: "CXL" },
  { product_id: "VIEW-EUR", product_type: "SPOT", status: "online", view_only: true, quote_currency_id: "EUR", base_currency_id: "VIEW" },
];

interface AssetState {
  asset: SimAsset;
  productId: string;
  /** Random-walk price without scenario effects. */
  basePrice: number;
  price: number;
  priceIncrement: number;
  scenario: Scenario | null;
}

export interface SimulatorOptions {
  seed?: number;
  catalog?: SimAsset[];
  /** Automatically start scenarios at random intervals. */
  autoScenarios?: boolean;
  scenarioIntervalSec?: [number, number];
}

export interface StepResult {
  frames: string[];
  scenariosStarted: Scenario[];
  scenariosEnded: Scenario[];
}

function priceIncrementFor(price: number): number {
  const magnitude = Math.floor(Math.log10(price));
  return 10 ** (magnitude - 4);
}

function roundTo(x: number, inc: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(inc)));
  return Number((Math.round(x / inc) * inc).toFixed(decimals));
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export class MarketSimulator {
  private readonly rng: Prng;
  private readonly assets: AssetState[];
  private lastStepMs: number | null = null;
  private lastHeartbeatSec: number | null = null;
  private heartbeatCounter = 0;
  private sequence = 0;
  private tradeSeq = 1_000_000;
  private nextScenarioAt: number | null = null;
  private readonly opts: Required<SimulatorOptions>;

  constructor(opts: SimulatorOptions = {}) {
    this.opts = {
      seed: opts.seed ?? 42,
      catalog: opts.catalog ?? DEFAULT_CATALOG,
      autoScenarios: opts.autoScenarios ?? true,
      scenarioIntervalSec: opts.scenarioIntervalSec ?? [25, 50],
    };
    this.rng = new Prng(this.opts.seed);
    this.assets = this.opts.catalog.map((a) => ({
      asset: a,
      productId: `${a.base}-${a.quote}`,
      basePrice: a.price,
      price: a.price,
      priceIncrement: priceIncrementFor(a.price),
      scenario: null,
    }));
  }

  productIds(): string[] {
    return this.assets.map((a) => a.productId);
  }

  /** Current prices (scenario effects included), to resume a simulation later. */
  exportPrices(): Record<string, number> {
    return Object.fromEntries(this.assets.map((a) => [a.productId, a.price]));
  }

  /** Resume from saved prices (unknown ids and invalid values are ignored). */
  importPrices(prices: Record<string, number>) {
    for (const a of this.assets) {
      const p = prices[a.productId];
      if (typeof p === "number" && Number.isFinite(p) && p > 0) {
        a.basePrice = p;
        a.price = p;
        a.scenario = null;
      }
    }
  }

  activeScenarios(): Scenario[] {
    return this.assets.flatMap((a) => (a.scenario ? [a.scenario] : []));
  }

  /** Payload shaped like `GET /api/v3/brokerage/market/products`. */
  productsResponse(): unknown {
    const products = [
      ...this.assets.map((s) => ({
        product_id: s.productId,
        price: String(roundTo(s.price, s.priceIncrement)),
        price_percentage_change_24h: this.rng.range(-4, 4).toFixed(4),
        volume_24h: String(s.asset.volume24hQuote / s.price),
        volume_percentage_change_24h: "0",
        base_increment: "0.00000001",
        quote_increment: String(s.priceIncrement),
        quote_min_size: "1",
        quote_max_size: "1000000",
        base_min_size: "0.00000001",
        base_max_size: "100000000",
        base_name: s.asset.name,
        quote_name: s.asset.quote === "EUR" ? "Euro" : "USDC",
        is_disabled: false,
        new: false,
        status: "online",
        cancel_only: false,
        limit_only: false,
        post_only: false,
        trading_disabled: false,
        auction_mode: false,
        product_type: "SPOT",
        quote_currency_id: s.asset.quote,
        base_currency_id: s.asset.base,
        mid_market_price: "",
        alias: "",
        alias_to: [],
        base_display_symbol: s.asset.base,
        quote_display_symbol: s.asset.quote,
        view_only: false,
        price_increment: String(s.priceIncrement),
        display_name: `${s.asset.base}/${s.asset.quote}`,
        product_venue: "CBE",
        approximate_quote_24h_volume: String(s.asset.volume24hQuote),
      })),
      ...NON_RADAR_PRODUCTS,
    ];
    return { products, num_products: products.length };
  }

  /** Start a scenario now (manual trigger, also used by tests). */
  startScenario(kind: ScenarioKind, nowMs: number, productId?: string): Scenario | null {
    const candidates = this.assets.filter((a) => {
      if (a.scenario) return false;
      const illiquid = a.asset.volume24hQuote < 100_000;
      return kind === "illiquid_pump" ? illiquid : !illiquid;
    });
    const target = productId ? this.assets.find((a) => a.productId === productId) : this.rng.pick(candidates);
    if (!target || target.scenario) return null;
    const r = this.rng;
    const sc: Scenario = (() => {
      switch (kind) {
        case "pump":
          return { kind, productId: target.productId, startMs: nowMs, durationMs: r.range(60, 120) * 1000, magnitudePct: r.range(3, 8), volumeMult: r.range(4, 8), spreadMult: 1 };
        case "dump":
          return { kind, productId: target.productId, startMs: nowMs, durationMs: r.range(60, 120) * 1000, magnitudePct: -r.range(3, 7), volumeMult: r.range(3, 6), spreadMult: 1.5 };
        case "illiquid_pump":
          return { kind, productId: target.productId, startMs: nowMs, durationMs: r.range(50, 90) * 1000, magnitudePct: r.range(6, 15), volumeMult: r.range(5, 10), spreadMult: 4 };
        case "volume_only":
          return { kind, productId: target.productId, startMs: nowMs, durationMs: 60_000, magnitudePct: r.range(0.1, 0.4), volumeMult: r.range(5, 10), spreadMult: 1 };
      }
    })();
    target.scenario = sc;
    return sc;
  }

  /** Scenario price factor: accelerating rise over 80 % of the duration, then a partial fade. */
  private scenarioFactor(sc: Scenario, nowMs: number): number {
    const u = Math.min(1, Math.max(0, (nowMs - sc.startMs) / sc.durationMs));
    const m = sc.magnitudePct / 100;
    if (u <= 0.8) return m * (u / 0.8) ** 2;
    return m * (1 - 0.3 * ((u - 0.8) / 0.2));
  }

  private frame(channel: string, nowMs: number, events: unknown[]): string {
    return JSON.stringify({ channel, client_id: "", timestamp: iso(nowMs), sequence_num: this.sequence++, events });
  }

  /** Advance the simulation to `nowMs` and return the frames produced. */
  step(nowMs: number): StepResult {
    const res: StepResult = { frames: [], scenariosStarted: [], scenariosEnded: [] };
    const first = this.lastStepMs === null;
    const dtSec = first ? 0 : Math.max(0, (nowMs - (this.lastStepMs as number)) / 1000);
    this.lastStepMs = nowMs;

    if (first) {
      res.frames.push(
        this.frame("subscriptions", nowMs, [
          { subscriptions: { ticker: this.productIds(), market_trades: this.productIds(), heartbeats: ["heartbeats"] } },
        ]),
      );
    }

    // Scenario scheduling.
    if (this.opts.autoScenarios) {
      const [lo, hi] = this.opts.scenarioIntervalSec;
      if (this.nextScenarioAt === null) this.nextScenarioAt = nowMs + this.rng.range(8, 15) * 1000;
      else if (nowMs >= this.nextScenarioAt) {
        const roll = this.rng.next();
        const kind: ScenarioKind = roll < 0.4 ? "pump" : roll < 0.6 ? "volume_only" : roll < 0.8 ? "dump" : "illiquid_pump";
        const sc = this.startScenario(kind, nowMs);
        if (sc) res.scenariosStarted.push(sc);
        this.nextScenarioAt = nowMs + this.rng.range(lo, hi) * 1000;
      }
    }

    const tickers: unknown[] = [];
    const trades: unknown[] = [];
    for (const s of this.assets) {
      const a = s.asset;
      // Random walk (GBM) on the base price.
      if (dtSec > 0) {
        const sigmaPerSqrtSec = a.dailyVolPct / 100 / Math.sqrt(86_400);
        s.basePrice *= Math.exp(sigmaPerSqrtSec * Math.sqrt(dtSec) * this.rng.normal());
      }
      let factor = 0;
      let volumeMult = 1;
      let spreadMult = 1;
      const sc = s.scenario;
      if (sc) {
        factor = this.scenarioFactor(sc, nowMs);
        volumeMult = sc.volumeMult;
        spreadMult = sc.spreadMult;
        if (nowMs >= sc.startMs + sc.durationMs) {
          s.basePrice *= 1 + factor; // the move is kept after the scenario
          factor = 0;
          s.scenario = null;
          res.scenariosEnded.push(sc);
        }
      }
      s.price = s.basePrice * (1 + factor);

      // Trades (Poisson arrivals).
      const lambda = (a.volume24hQuote / 86_400 / a.avgTradeQuote) * volumeMult * dtSec;
      const n = Math.min(40, this.rng.poisson(lambda));
      let lastTradePrice: number | null = null;
      for (let i = 0; i < n; i++) {
        const px = roundTo(s.price * (1 + (this.rng.next() - 0.5) * (a.spreadBps / 10_000)), s.priceIncrement);
        const size = Math.max(1e-8, this.rng.exponential(a.avgTradeQuote) / px);
        const tMs = nowMs - Math.floor(this.rng.next() * dtSec * 1000);
        trades.push({
          trade_id: String(this.tradeSeq++),
          product_id: s.productId,
          price: String(px),
          size: size.toPrecision(8),
          side: this.rng.next() < 0.5 ? "BUY" : "SELL",
          time: iso(tMs),
        });
        lastTradePrice = px;
      }

      // Ticker: snapshot on the first step, then after each batch of trades.
      if (first || lastTradePrice !== null) {
        const px = lastTradePrice ?? roundTo(s.price, s.priceIncrement);
        const half = ((a.spreadBps * spreadMult) / 10_000 / 2) * s.price;
        const bid = roundTo(Math.min(px, s.price - half), s.priceIncrement);
        const ask = roundTo(Math.max(px, s.price + half, bid + s.priceIncrement), s.priceIncrement);
        const depthQuote = (a.volume24hQuote / 2_000) / spreadMult;
        tickers.push({
          type: "ticker",
          product_id: s.productId,
          price: String(px),
          volume_24_h: String(a.volume24hQuote / s.price),
          low_24_h: String(roundTo(s.price * 0.96, s.priceIncrement)),
          high_24_h: String(roundTo(s.price * 1.04, s.priceIncrement)),
          low_52_w: String(roundTo(a.price * 0.5, s.priceIncrement)),
          high_52_w: String(roundTo(a.price * 1.5, s.priceIncrement)),
          price_percent_chg_24_h: (((s.price - a.price) / a.price) * 100).toFixed(4),
          best_bid: String(bid),
          best_ask: String(ask),
          best_bid_quantity: ((depthQuote / 2 / bid) * this.rng.range(0.5, 1.5)).toPrecision(8),
          best_ask_quantity: ((depthQuote / 2 / ask) * this.rng.range(0.5, 1.5)).toPrecision(8),
        });
      }
    }

    if (trades.length) res.frames.push(this.frame("market_trades", nowMs, [{ type: "update", trades }]));
    if (tickers.length) res.frames.push(this.frame("ticker", nowMs, [{ type: first ? "snapshot" : "update", tickers }]));

    const sec = Math.floor(nowMs / 1000);
    if (this.lastHeartbeatSec !== sec) {
      this.lastHeartbeatSec = sec;
      res.frames.push(
        this.frame("heartbeats", nowMs, [
          { current_time: new Date(nowMs).toISOString(), heartbeat_counter: String(this.heartbeatCounter++) },
        ]),
      );
    }
    return res;
  }
}

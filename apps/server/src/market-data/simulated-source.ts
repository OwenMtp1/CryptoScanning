import { MarketSimulator, parseProductsPage, type ScenarioKind } from "@radar/core";
import type { FrameSink, LogFn, MarketDataSource, ProductsLoadResult, SourceStatus } from "./source.js";

export interface SimulatedSourceOptions {
  seed: number;
  tickMs: number;
  log: LogFn;
  autoScenarios?: boolean;
  /** Resume from saved prices (demo continuity). */
  initialPrices?: Record<string, number>;
}

/**
 * Simulated market (FICTITIOUS data) emitting Coinbase-format frames.
 * Used while the real Coinbase endpoints are not reachable.
 */
export class SimulatedMarketSource implements MarketDataSource {
  readonly kind = "simulated" as const;
  private readonly sim: MarketSimulator;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt: number | null = null;
  private subscribed = 0;

  constructor(private readonly opts: SimulatedSourceOptions) {
    this.sim = new MarketSimulator({ seed: opts.seed, autoScenarios: opts.autoScenarios ?? true });
    if (opts.initialPrices) this.sim.importPrices(opts.initialPrices);
  }

  async loadProducts(): Promise<ProductsLoadResult> {
    // Same parsing path as the REST response.
    const page = parseProductsPage(this.sim.productsResponse());
    return { products: page.products, invalid: page.invalid };
  }

  start(productIds: string[], sink: FrameSink) {
    this.stop();
    this.subscribed = productIds.length;
    const tick = () => {
      const now = Date.now();
      const r = this.sim.step(now);
      for (const sc of r.scenariosStarted) {
        this.opts.log({
          type: "SIMULATION_SCENARIO",
          level: "info",
          productId: sc.productId,
          message: `[SIM] scénario ${sc.kind} sur ${sc.productId} : ${sc.magnitudePct.toFixed(1)} % en ${Math.round(sc.durationMs / 1000)} s, volume ×${sc.volumeMult.toFixed(1)}`,
          data: { ...sc },
        });
      }
      for (const f of r.frames) sink.onFrame(f, now, "sim");
      if (r.frames.length) this.lastMessageAt = now;
    };
    tick();
    this.timer = setInterval(tick, this.opts.tickMs);
  }

  exportPrices(): Record<string, number> {
    return this.sim.exportPrices();
  }

  /** Manually trigger a scenario (dev tooling / tests). */
  trigger(kind: ScenarioKind, productId?: string) {
    return this.sim.startScenario(kind, Date.now(), productId);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): SourceStatus {
    const running = this.timer !== null;
    return {
      source: "simulated",
      state: running ? "open" : "closed",
      connections: 1,
      openConnections: running ? 1 : 0,
      subscribedProducts: this.subscribed,
      lastMessageAt: this.lastMessageAt,
      reconnects: 0,
    };
  }
}

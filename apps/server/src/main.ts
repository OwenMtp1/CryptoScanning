import { createApiServer } from "./api/http-server.js";
import { loadEnv, loadSignalConfig, loadTradingConfig } from "./config/env.js";
import { EventLog } from "./logging/event-log.js";
import { CoinbaseMarketSource } from "./market-data/coinbase-source.js";
import { MarketDataEngine } from "./market-data/market-data-engine.js";
import { SimulatedMarketSource } from "./market-data/simulated-source.js";
import type { MarketDataSource } from "./market-data/source.js";
import { RadarService } from "./signal-engine/radar-service.js";
import { PaperStore } from "./trading/paper-store.js";
import { StrategyStore } from "./trading/strategy-store.js";
import { TradingService } from "./trading/trading-service.js";
import { IMPLEMENTED_MODES, parseMode } from "./config/mode.js";
const PRODUCTS_RETRY_MS = 30_000;

async function main() {
  const env = loadEnv();
  const log = new EventLog({ dir: env.logDir });
  const emit = (e: Parameters<EventLog["emit"]>[0]) => void log.emit(e);

  const parsedMode = parseMode(env.MODE);
  if (!parsedMode.ok) {
    log.emit({ type: "MODE_CHANGE_REJECTED", level: "error", success: false, message: parsedMode.message });
    await log.close();
    process.exit(1);
  }
  const mode = parsedMode.mode;

  const { config: signalConfig, source: configSource } = loadSignalConfig(env.signalConfigPath);
  log.emit({
    type: "CONFIG_LOADED",
    level: "info",
    message: `Configuration des signaux : ${configSource === "file" ? env.signalConfigPath : "valeurs par défaut"}`,
    data: { signalConfig },
  });
  const { config: tradingConfig, source: tradingSource } = loadTradingConfig(env.tradingConfigPath);
  log.emit({
    type: "CONFIG_LOADED",
    level: "info",
    message: `Configuration trading : ${tradingSource === "file" ? env.tradingConfigPath : "valeurs par défaut"} — ${tradingConfig.strategies.length} stratégie(s), frais taker ${tradingConfig.paper.takerFeePct} % (hypothèse)`,
    data: { tradingConfig },
  });

  const source: MarketDataSource =
    env.DATA_SOURCE === "coinbase"
      ? new CoinbaseMarketSource({
          restBaseUrl: env.COINBASE_REST_BASE_URL,
          restMaxRps: env.COINBASE_REST_MAX_RPS,
          wsUrl: env.COINBASE_WS_URL,
          productsPerConnection: env.WS_PRODUCTS_PER_CONNECTION,
          maxSubscribeMsgPerSec: env.WS_MAX_SUBSCRIBE_MSG_PER_SEC,
          log: emit,
        })
      : new SimulatedMarketSource({ seed: env.SIM_SEED, tickMs: env.SIM_TICK_MS, log: emit });

  const market = new MarketDataEngine({
    source,
    config: signalConfig,
    log: emit,
    quoteCurrencies: env.QUOTE_CURRENCIES,
    maxProducts: env.MAX_PRODUCTS,
    requiredProducts: TradingService.requiredProducts(tradingConfig),
  });
  const tradingMode = mode;
  let trading: TradingService;
  try {
    trading = new TradingService({
      mode: tradingMode,
      config: tradingConfig,
      market,
      log: emit,
      store: tradingMode === "PAPER" ? new PaperStore(env.paperDataDir) : null,
      strategyStore: new StrategyStore(env.strategiesDir),
    });
  } catch (err) {
    log.emit({ type: "API_ERROR", level: "error", success: false, message: `Démarrage du trading impossible : ${(err as Error).message}` });
    await log.close();
    process.exit(1);
  }
  const radar = new RadarService(market, signalConfig, emit, env.EVAL_INTERVAL_MS, tradingMode);
  // Trading runs first on each snapshot so the dashboard stream sees fresh state.
  radar.subscribe((snap) => trading.onSnapshot(snap));
  const startedAt = Date.now();

  const server = createApiServer({
    log,
    market,
    radar,
    trading,
    allowedOrigins: env.DASHBOARD_ORIGINS,
    startedAt,
    publicConfig: () => ({
      mode,
      implementedModes: IMPLEMENTED_MODES,
      dataSource: env.DATA_SOURCE,
      quoteCurrencies: env.QUOTE_CURRENCIES,
      maxProducts: env.MAX_PRODUCTS,
      evalIntervalMs: env.EVAL_INTERVAL_MS,
      signalConfig,
      signalConfigSource: configSource,
      tradingConfig,
      tradingConfigSource: tradingSource,
      coinbase: {
        restBaseUrl: env.COINBASE_REST_BASE_URL,
        wsUrl: env.COINBASE_WS_URL,
        restMaxRps: env.COINBASE_REST_MAX_RPS,
        wsProductsPerConnection: env.WS_PRODUCTS_PER_CONNECTION,
        authentication: "aucune (phase 1 : données publiques uniquement)",
        apiKeyConfigured: false,
        keyPermissions: null,
        tradabilityVerified: false,
      },
    }),
  });
  server.listen(env.PORT, env.HOST, () => {
    log.emit({
      type: "SYSTEM_STARTED",
      level: "info",
      success: true,
      message: `Radar démarré en mode ${mode} — source ${env.DATA_SOURCE.toUpperCase()} — API http://${env.HOST}:${env.PORT}`,
      data: { mode, dataSource: env.DATA_SOURCE, host: env.HOST, port: env.PORT },
    });
  });

  // Load products (retry on failure, never crash the API), then stream.
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const boot = async () => {
    try {
      await market.loadProducts();
      market.start();
      radar.start();
    } catch (err) {
      log.emit({
        type: "API_ERROR",
        level: "error",
        success: false,
        message: `Chargement des produits impossible (${(err as Error).message}). Nouvel essai dans ${PRODUCTS_RETRY_MS / 1000} s.`,
      });
      retryTimer = setTimeout(boot, PRODUCTS_RETRY_MS);
    }
  };
  void boot();

  const shutdown = async (signal: string) => {
    log.emit({ type: "SYSTEM_STOPPING", level: "info", message: `Arrêt demandé (${signal})` });
    if (retryTimer) clearTimeout(retryTimer);
    radar.stop();
    market.stop();
    server.closeAllConnections();
    server.close();
    await log.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});

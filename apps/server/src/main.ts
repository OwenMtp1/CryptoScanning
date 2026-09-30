import { createApiServer } from "./api/http-server.js";
import path from "node:path";
import { loadEnv, loadIntelConfig, loadSignalConfig, loadTradingConfig } from "./config/env.js";
import { BinanceFeed } from "./intel/binance-feed.js";
import { CallBudget, type BudgetState } from "./intel/budget.js";
import { CoinGeckoFeed } from "./intel/coingecko-feed.js";
import { DiscordNotifier } from "./intel/discord-notifier.js";
import { JsonFileStore } from "./intel/file-store.js";
import { fetchText } from "./intel/http.js";
import { IntelService, type IntelSavedState } from "./intel/intel-service.js";
import { NewsPoller } from "./intel/news-poller.js";
import { EventLog } from "./logging/event-log.js";
import { CoinbaseMarketSource } from "./market-data/coinbase-source.js";
import { MarketDataEngine } from "./market-data/market-data-engine.js";
import { SimulatedMarketSource } from "./market-data/simulated-source.js";
import type { MarketDataSource } from "./market-data/source.js";
import { RadarService } from "./signal-engine/radar-service.js";
import { PaperStore } from "./trading/paper-store.js";
import { StrategyStore } from "./trading/strategy-store.js";
import { AccountService } from "./coinbase/account-service.js";
import { loadCredentials } from "./coinbase/credentials.js";
import { CoinbasePublicRest } from "./market-data/coinbase-rest.js";
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

  // Coinbase account (optional, READ-ONLY). Secrets stay in this process only.
  const creds = loadCredentials(process.env);
  const accountRest = new CoinbasePublicRest({ baseUrl: env.COINBASE_REST_BASE_URL, maxRps: env.COINBASE_REST_MAX_RPS, log: emit, key: creds.key });
  let onAccountSync: (taker: number | null, ids: ReadonlySet<string>) => void = () => {};
  const account = new AccountService(accountRest, creds.key, creds.source, creds.error, emit, (t, ids) => onAccountSync(t, ids));

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
      accountProducts: () => account.productIds(),
    });
  } catch (err) {
    log.emit({ type: "API_ERROR", level: "error", success: false, message: `Démarrage du trading impossible : ${(err as Error).message}` });
    await log.close();
    process.exit(1);
  }
  onAccountSync = (taker, ids) => {
    trading.applyAccountFees(taker);
    market.setAccountProducts(ids);
  };
  const radar = new RadarService(market, signalConfig, emit, env.EVAL_INTERVAL_MS, tradingMode);
  // Trading runs first on each snapshot so the dashboard stream sees fresh state.
  radar.subscribe((snap) => trading.onSnapshot(snap));
  const startedAt = Date.now();

  // ─── Intelligence layer: all cryptos, many sources, Discord alerts ────────
  const intelStops: (() => void)[] = [];
  let intel: IntelService | undefined;
  let intelExtras: (() => Record<string, unknown>) | undefined;
  let startIntel = () => {};
  let saveIntel = () => {};
  let onProducts: (bases: string[]) => void = () => {};
  if (env.INTEL_ENABLED) {
    const { config: ic, source: icSource } = loadIntelConfig(env.intelConfigPath);
    log.emit({ type: "CONFIG_LOADED", level: "info", message: `Configuration intel : ${icSource === "file" ? env.intelConfigPath : "valeurs par défaut"}`, data: { intelConfig: ic } });
    const store = new JsonFileStore(path.join(env.intelDataDir, "state.json"));
    const saved = store.load() as IntelSavedState | null;
    const extras = (saved?.extras ?? {}) as { budget?: BudgetState; cgLastRun?: Record<string, number> };
    let ref: IntelService | null = null;
    const notifier = new DiscordNotifier({ webhookUrl: env.DISCORD_WEBHOOK_URL, cfg: ic.discord, fetchText, log: emit, hitRateOf: (s) => ref?.hitRateOf(s) ?? null });
    const coinbaseLive = env.DATA_SOURCE === "coinbase";
    const enabledSources = [
      ...(ic.binance.enabled ? (["binance"] as const) : []),
      ...(coinbaseLive ? (["coinbase"] as const) : []),
      ...(ic.coingecko.enabled ? (["coingecko", "trending", "derivatives"] as const) : []),
      ...(ic.coingecko.enabled && ic.coingecko.dex.enabled ? (["dex"] as const) : []),
      ...(ic.news.enabled ? (["news"] as const) : []),
      ...(notifier.active ? (["discord"] as const) : []),
    ];
    const svc = new IntelService({ cfg: ic, log: emit, notifier, enabledSources });
    ref = svc;
    intel = svc;
    svc.restore(saved);
    if (!notifier.active) svc.setSourceState("discord", "disabled", env.DISCORD_WEBHOOK_URL ? "URL de webhook invalide" : "DISCORD_WEBHOOK_URL non configurée");

    const budget = new CallBudget(ic.coingecko.monthlyCallBudget, ic.coingecko.maxCallsPerMinute, extras.budget ?? null, Date.now());
    const cg = ic.coingecko.enabled
      ? new CoinGeckoFeed({
          plan: env.coingeckoPlan,
          apiKey: env.COINGECKO_API_KEY,
          cfg: ic.coingecko,
          budget,
          fetchText,
          lastRun: extras.cgLastRun,
          handlers: {
            onMarkets: (rows, page, now) => svc.onMarkets(rows, page, now),
            onTrending: (list, now, categories) => svc.onTrending(list, now, categories),
            onDerivatives: (rows, now) => svc.onDerivatives(rows, now),
            onPools: (doc, isNew, now) => svc.onPools(doc, isNew, now),
            onSuccess: (task, n, now) => svc.onCoinGeckoResult(task, true, null, n, now),
            onError: (task, msg, now) => svc.onCoinGeckoResult(task, false, msg, 0, now),
          },
        })
      : null;
    const binance = ic.binance.enabled
      ? new BinanceFeed({
          restUrl: env.BINANCE_REST_URL,
          wsUrl: env.BINANCE_WS_URL,
          quotes: ic.binance.quotes,
          fetchText,
          onTick: (tracker, changed, now) => svc.onLive(tracker, changed, now),
          onState: (state, msg, now) => svc.setSourceState("binance", state === "connecting" ? "waiting" : state, msg, now),
        })
      : null;
    const news = ic.news.enabled
      ? new NewsPoller({
          feeds: ic.news.feeds,
          intervalSec: ic.news.intervalSec,
          fetchText,
          onItems: (feed, items, now) => svc.onNews(feed.name, items, now),
          onError: (feed, msg, now) => svc.setSourceState("news", "degraded", `${feed.name} : ${msg}`, now),
        })
      : null;
    if (coinbaseLive) radar.subscribeEvaluations((e) => svc.onCoinbaseEvaluation(e));
    onProducts = (bases) => {
      if (coinbaseLive) svc.markCoinbase(bases);
    };
    saveIntel = () => {
      try {
        store.save(svc.exportState({ budget: budget.export(), cgLastRun: cg?.lastRuns() ?? {} }));
      } catch (err) {
        emit({ type: "API_ERROR", level: "warn", success: false, message: `Sauvegarde intel impossible : ${(err as Error).message}` });
      }
    };
    intelExtras = () => {
      const now = Date.now();
      return {
        coingecko: cg ? { plan: env.coingeckoPlan, keyConfigured: env.COINGECKO_API_KEY !== null, budget: budget.view(now), stretch: cg.stretch(now), schedule: cg.schedule(now) } : null,
        binanceFeed: binance?.status() ?? null,
        newsFeeds: news?.feedsHealth() ?? [],
      };
    };
    startIntel = () => {
      cg?.start();
      void binance?.start();
      news?.start();
      notifier.start();
      const t1 = setInterval(() => svc.tickOutcomes(), 30_000);
      const t2 = setInterval(saveIntel, 60_000);
      intelStops.push(() => clearInterval(t1), () => clearInterval(t2), () => cg?.stop(), () => binance?.stop(), () => news?.stop(), () => notifier.stop());
    };
  }

  const server = createApiServer({
    log,
    market,
    radar,
    trading,
    account,
    intel,
    intelExtras,
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
        authentication: account.view().configured ? `clé CDP ${account.view().algorithm} (lecture seule)` : "aucune (données publiques uniquement)",
        apiKeyConfigured: account.view().configured,
        keyPermissions: account.view().permissions,
        tradabilityVerified: account.view().state === "connected",
        account: account.view(),
      },
    }),
  });
  // Intel sources do not depend on Coinbase products: start them right away.
  startIntel();
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
      onProducts(market.getProducts().map((p) => p.baseCurrency));
      market.start();
      radar.start();
      void account.start();
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
    account.stop();
    for (const stop of intelStops) stop();
    saveIntel();
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

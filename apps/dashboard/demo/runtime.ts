/**
 * Standalone demo: the SAME engine as the local server (market simulator,
 * Market Data Engine, Signal Engine, Strategy Engine, Risk Engine, paper
 * execution) runs inside the page. Nothing talks to Coinbase.
 */
import { StrategiesFileSchema, TradingConfigSchema, defaultSignalConfig, type LogEvent, type Strategy } from "@radar/core";
import { handleAction, handleGet, statusOf, type RouteContext } from "../../server/src/api/routes";
import { MarketDataEngine } from "../../server/src/market-data/market-data-engine";
import { SimulatedMarketSource } from "../../server/src/market-data/simulated-source";
import { RadarService } from "../../server/src/signal-engine/radar-service";
import { parsePaperState, type PaperStateFile } from "../../server/src/trading/paper-state";
import { TradingService } from "../../server/src/trading/trading-service";
import type { DemoBackend } from "../lib/api";
import { BrowserEventLog } from "./event-log";
import { createStorage, type DemoStorage } from "./storage";

const MAX_PERSISTED_TRADES = 150;
const MAX_PERSISTED_EQUITY = 1500;
const FLUSH_MS = 20_000;

export interface DemoInfo {
  storage: DemoStorage["kind"];
  resumed: boolean;
  savedAt: string | null;
}

/** Keep the persisted paper state under the per-document size limit. */
function compact(s: PaperStateFile): PaperStateFile {
  let trades = MAX_PERSISTED_TRADES;
  let equity = MAX_PERSISTED_EQUITY;
  for (;;) {
    const c = { ...s, trades: s.trades.slice(-trades), equity: s.equity.slice(-equity) };
    if (JSON.stringify(c).length < 230_000 || trades < 10) return c;
    trades = Math.floor(trades / 2);
    equity = Math.floor(equity / 2);
  }
}

export async function startDemo(): Promise<{ backend: DemoBackend; info: DemoInfo; storage: DemoStorage }> {
  const storage = await createStorage();
  const [paperRaw, stratRaw, simRaw, logRaw] = await Promise.all([storage.load("paper"), storage.load("strategies"), storage.load("sim"), storage.load("log")]);

  let paper: PaperStateFile | null = null;
  try {
    paper = paperRaw ? parsePaperState(paperRaw) : null;
  } catch {
    paper = null; // a corrupted demo state restarts cleanly (the local server refuses instead)
  }
  let strategies: Strategy[] | null = null;
  const sp = StrategiesFileSchema.safeParse(stratRaw);
  if (sp.success) strategies = sp.data.strategies;
  const prices = simRaw && typeof simRaw === "object" ? (simRaw as { prices?: Record<string, number> }).prices : undefined;
  const logInit = Array.isArray(logRaw) ? (logRaw as LogEvent[]) : [];

  const log = new BrowserEventLog(logInit);
  const emit = (e: Parameters<BrowserEventLog["emit"]>[0]) => void log.emit(e);
  const signalConfig = defaultSignalConfig();
  const tradingConfig = TradingConfigSchema.parse({});

  const source = new SimulatedMarketSource({ seed: Math.floor(Math.random() * 1e9), tickMs: 250, log: emit, initialPrices: prices });
  const market = new MarketDataEngine({
    source,
    config: signalConfig,
    log: emit,
    quoteCurrencies: ["EUR", "USDC"],
    maxProducts: 100,
    requiredProducts: TradingService.requiredProducts(tradingConfig),
  });
  let latestPaper: PaperStateFile | null = null;
  const trading = new TradingService({
    mode: "PAPER",
    config: tradingConfig,
    market,
    log: emit,
    // The engine calls save() on every change; serialization happens only at flush time.
    store: { load: () => paper, save: (s) => void (latestPaper = s) },
    strategyStore: {
      load: () => strategies,
      save: (list) => {
        storage.save("strategies", { version: 1, savedAt: new Date().toISOString(), strategies: list });
        void storage.flush(); // strategy edits are saved right away
      },
    },
  });
  const radar = new RadarService(market, signalConfig, emit, 1000, "PAPER");
  radar.subscribe((snap) => trading.onSnapshot(snap));

  const startedAt = Date.now();
  const ctx: RouteContext = {
    log,
    market,
    radar,
    trading,
    account: {
      view: () => ({
        configured: false,
        state: "disabled",
        message: "démo : aucune connexion Coinbase (tout est simulé dans le navigateur)",
        keyName: null,
        keySource: null,
        algorithm: null,
        permissions: null,
        balances: [],
        fees: null,
        accountProducts: null,
        lastSyncAt: null,
        tradingEnabled: false,
      }),
    },
    startedAt,
    publicConfig: () => ({
      mode: "PAPER",
      implementedModes: ["RADAR", "PAPER"],
      dataSource: "simulated",
      quoteCurrencies: ["EUR", "USDC"],
      maxProducts: 100,
      evalIntervalMs: 1000,
      signalConfig,
      signalConfigSource: "defaults",
      tradingConfig,
      tradingConfigSource: "defaults",
      coinbase: {
        restBaseUrl: "— (démo hors ligne)",
        wsUrl: "— (démo hors ligne)",
        restMaxRps: 3,
        wsProductsPerConnection: 25,
        authentication: "aucune (démo)",
        apiKeyConfigured: false,
        keyPermissions: null,
        tradabilityVerified: false,
        account: ctx.account?.view(),
      },
    }),
  };

  await market.loadProducts();
  market.start();
  radar.start();
  emit({ type: "SYSTEM_STARTED", level: "info", success: true, message: `Démo démarrée dans le navigateur — mode PAPER, données simulées — sauvegarde : ${storage.kind}${paper ? " (session précédente reprise)" : ""}` });

  const persist = () => {
    if (latestPaper) storage.save("paper", compact(structuredClone(latestPaper)));
    storage.save("sim", { prices: source.exportPrices(), savedAt: new Date().toISOString() });
    storage.save("log", log.recent(300));
    void storage.flush();
  };
  setInterval(persist, FLUSH_MS);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && persist());
  window.addEventListener("pagehide", persist);

  const backend: DemoBackend = {
    async get(path) {
      const u = new URL(path, "https://demo.local");
      const r = handleGet(ctx, u.pathname, u.searchParams);
      if (!r || r.status >= 400) throw new Error(`${path} → ${r?.status ?? 404}`);
      return structuredClone(r.body);
    },
    async post(path, body) {
      const r = handleAction(ctx, new URL(path, "https://demo.local").pathname, structuredClone(body));
      persist();
      return { status: r.status, body: structuredClone(r.body) };
    },
    subscribe(onEvent) {
      const send = (event: string, data: unknown) => onEvent(event, structuredClone(data));
      send("status", statusOf(ctx));
      send("trading", trading.view());
      const snap = radar.snapshot();
      if (snap) send("snapshot", snap);
      const offRadar = radar.subscribe((s) => {
        send("snapshot", s);
        send("status", statusOf(ctx));
        send("trading", trading.view());
      });
      const offLog = log.subscribe((e) => e.level !== "debug" && send("log", e));
      return () => {
        offRadar();
        offLog();
      };
    },
  };
  return { backend, info: { storage: storage.kind, resumed: !!paper, savedAt: paper?.savedAt ?? null }, storage };
}

/** Erase the saved demo session (both storages). */
export async function resetDemo(storage: DemoStorage) {
  for (const k of ["paper", "strategies", "sim", "log"]) storage.save(k, null);
  await storage.flush();
}

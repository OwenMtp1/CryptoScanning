/**
 * Live website runtime: the SAME IntelService as the local server, running in
 * the visitor's browser on REAL market data.
 *
 * - Binance: WebSocket straight from the browser (public market data).
 * - CoinGecko / GeckoTerminal: through the Cloudflare function `/api/cg`
 *   (shared edge cache + the API key stays on the server side).
 * - News: through the Cloudflare function `/api/news` (RSS feeds cannot be
 *   read cross-origin from a browser).
 * No Discord here: alerts need a process that runs 24/7.
 */
import { IntelConfigSchema, parseFeed, type LogEvent } from "@radar/core";
import { handleAction, handleGet, type RouteContext } from "../../server/src/api/routes";
import { BinanceFeed } from "../../server/src/intel/binance-feed";
import { CallBudget } from "../../server/src/intel/budget";
import { CoinGeckoFeed } from "../../server/src/intel/coingecko-feed";
import { fetchText, type FetchText } from "../../server/src/intel/http";
import { IntelService, type IntelSavedState } from "../../server/src/intel/intel-service";
import type { DemoBackend } from "../lib/api";
import { BrowserEventLog } from "../demo/event-log";

const STORE_KEY = "crypto-radar-web-v1";
const BINANCE_REST = "https://data-api.binance.vision";
const BINANCE_WS = "wss://data-stream.binance.vision";
const NEWS_EVERY_MS = 5 * 60_000;

interface NewsListResponse {
  feeds: { id: string; name: string; url: string; lang: string }[];
}

/** exchangeInfo straight from Binance, or through our function when the browser call is refused. */
const binanceFetch: FetchText = async (url, init) => {
  try {
    const r = await fetchText(url, init);
    if (r.status === 200) return r;
    throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    if (!url.includes("/api/v3/exchangeInfo")) throw err;
    return fetchText("/api/binance/exchangeInfo", init);
  }
};

function load(): (IntelSavedState & { extras?: { cgLastRun?: Record<string, number> } }) | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as IntelSavedState) : null;
  } catch {
    return null;
  }
}

export async function startWeb(): Promise<DemoBackend> {
  const cfg = IntelConfigSchema.parse({ coingecko: { universeSize: 750 } });
  const log = new BrowserEventLog([], 1500);
  const emit = (e: Parameters<BrowserEventLog["emit"]>[0]) => void log.emit(e);
  const svc = new IntelService({ cfg, log: emit, notifier: null, enabledSources: ["binance", "coingecko", "trending", "derivatives", "dex", "news"] });
  const saved = load();
  svc.restore(saved);

  const binance = new BinanceFeed({
    restUrl: BINANCE_REST,
    wsUrl: BINANCE_WS,
    quotes: cfg.binance.quotes,
    fetchText: binanceFetch,
    onTick: (tracker, changed, now) => svc.onLive(tracker, changed, now),
    onState: (state, msg, now) => svc.setSourceState("binance", state === "connecting" ? "waiting" : state, msg, now),
  });
  const cg = new CoinGeckoFeed({
    plan: "public",
    apiKey: null,
    baseUrl: "/api/cg",
    // The shared edge cache refreshes every 30–60 min; asking more often only re-reads the cache.
    intervalMultiplier: 3,
    cfg: cfg.coingecko,
    budget: new CallBudget(1_000_000, 20, null, Date.now()),
    fetchText,
    lastRun: saved?.extras?.cgLastRun,
    handlers: {
      onMarkets: (rows, page, now) => svc.onMarkets(rows, page, now),
      onTrending: (list, now) => svc.onTrending(list, now),
      onDerivatives: (rows, now) => svc.onDerivatives(rows, now),
      onPools: (doc, isNew, now) => svc.onPools(doc, isNew, now),
      onSuccess: (task, n, now) => svc.onCoinGeckoResult(task, true, null, n, now),
      onError: (task, msg, now) => svc.onCoinGeckoResult(task, false, msg, 0, now),
    },
  });

  let newsFeeds: { name: string; url: string; lang: string; ok: boolean | null; lastSuccessAt: number | null; lastError: string | null; items: number }[] = [];
  const pollNews = async () => {
    try {
      const r = await fetchText("/api/news", { timeoutMs: 15_000 });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const list = (JSON.parse(r.text) as NewsListResponse).feeds;
      if (!newsFeeds.length) newsFeeds = list.map((f) => ({ name: f.name, url: f.url, lang: f.lang, ok: null, lastSuccessAt: null, lastError: null, items: 0 }));
      for (const f of list) {
        const h = newsFeeds.find((x) => x.url === f.url);
        const now = Date.now();
        try {
          const x = await fetchText(`/api/news/${encodeURIComponent(f.id)}`, { timeoutMs: 20_000 });
          if (x.status !== 200) throw new Error(`HTTP ${x.status}`);
          const items = parseFeed(x.text);
          if (!items.length) throw new Error("flux vide ou illisible");
          svc.onNews(f.name, items, now);
          if (h) Object.assign(h, { ok: true, lastSuccessAt: now, lastError: null, items: items.length });
        } catch (err) {
          if (h) Object.assign(h, { ok: false, lastError: (err as Error).message });
        }
      }
      const bad = newsFeeds.filter((f) => f.ok === false);
      if (bad.length) svc.setSourceState("news", bad.length === newsFeeds.length ? "down" : "degraded", `${bad.length} flux en erreur : ${bad.map((f) => f.name).join(", ")}`);
    } catch (err) {
      svc.setSourceState("news", "down", `actualités indisponibles : ${(err as Error).message}`);
    }
  };

  const save = () => {
    const st = svc.exportState({ cgLastRun: cg.lastRuns() });
    let keep = 4000;
    for (;;) {
      try {
        const compact = { ...st, tracker: st.tracker.slice(-keep), engine: { signals: st.engine.signals.slice(-Math.min(800, keep)), news: st.engine.news.slice(-Math.min(400, keep)) } };
        localStorage.setItem(STORE_KEY, JSON.stringify(compact));
        return;
      } catch {
        keep = Math.floor(keep / 2);
        if (keep < 50) return; // storage unavailable (private window…): run without persistence
      }
    }
  };

  void binance.start();
  cg.start();
  void pollNews();
  setInterval(() => void pollNews(), NEWS_EVERY_MS);
  setInterval(() => svc.tickOutcomes(), 30_000);
  setInterval(save, 60_000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && save());
  window.addEventListener("pagehide", save);

  const startedAt = Date.now();
  const ctx = {
    log,
    intel: svc,
    intelExtras: () => ({ web: true, simulated: false, coingecko: null, binanceFeed: binance.status(), newsFeeds }),
    publicConfig: () => ({ mode: "WEB" }),
    startedAt,
  } as unknown as RouteContext;
  emit({ type: "SYSTEM_STARTED", level: "info", success: true, message: "Site live : analyse multi-sources démarrée dans le navigateur" });

  return {
    async get(path) {
      const u = new URL(path, "https://site.local");
      const r = handleGet(ctx, u.pathname, u.searchParams);
      if (!r || r.status >= 400) throw new Error(`${path} → ${r?.status ?? 404}`);
      return r.body;
    },
    async post(path, body) {
      const r = await handleAction(ctx, new URL(path, "https://site.local").pathname, body);
      return { status: r.status, body: r.body };
    },
    subscribe(onEvent) {
      const offIntel = svc.subscribe((b) => onEvent("intel", b));
      const offLog = log.subscribe((e: LogEvent) => e.level !== "debug" && onEvent("log", e));
      onEvent("status", null);
      return () => {
        offIntel();
        offLog();
      };
    },
  };
}

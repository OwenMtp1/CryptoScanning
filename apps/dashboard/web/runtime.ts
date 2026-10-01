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
import {
  CoinbasePriceHistory,
  IntelConfigSchema,
  createDemo,
  demoBuy,
  demoClose,
  demoDeposit,
  demoOpen,
  demoSell,
  loadDemo,
  parseFeed,
  parseProductsPage,
  tickDemo,
  valueDemo,
  type DemoResult,
  type DemoState,
  type LogEvent,
} from "@radar/core";
import { handleAction, handleGet, type RouteContext } from "../../server/src/api/routes";
import { loadPerpMarkets } from "../../server/src/intel/perp-sources";
import { BinanceFeed } from "../../server/src/intel/binance-feed";
import { CallBudget } from "../../server/src/intel/budget";
import { CoinGeckoFeed } from "../../server/src/intel/coingecko-feed";
import { fetchText, type FetchText } from "../../server/src/intel/http";
import { IntelService, type IntelSavedState, type SetupView } from "../../server/src/intel/intel-service";
import { loadCandles, type CandleInterval } from "../../server/src/intel/candles";
import { runSetup } from "../../server/src/intel/setup-scanner";
import type { DemoBackend } from "../lib/api";
import { BrowserEventLog } from "../demo/event-log";

const STORE_KEY = "crypto-radar-web-v1";
const RELAY_KEY_STORE = "crypto-radar-relay-key";
const BINANCE_REST = "https://data-api.binance.vision";
const BINANCE_WS = "wss://data-stream.binance.vision";
const NEWS_EVERY_MS = 5 * 60_000;

interface NewsListResponse {
  feeds: { id: string; name: string; url: string; lang: string; kind?: string }[];
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
  const svc = new IntelService({ cfg, log: emit, notifier: null, enabledSources: ["binance", "coinbase", "coingecko", "trending", "derivatives", "dex", "news", "social", "leverage", "setup", "verdict", "discord"] });
  const saved = load();
  svc.restore(saved);

  const binance = new BinanceFeed({
    restUrl: BINANCE_REST,
    wsUrl: BINANCE_WS,
    quotes: cfg.binance.quotes,
    fetchText: binanceFetch,
    discoverOnFailure: true,
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
      onTrending: (list, now, categories) => svc.onTrending(list, now, categories),
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
          if (f.kind === "social") svc.onSocial(f.name, items, now);
          else svc.onNews(f.name, items, now);
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

  // Coinbase: public product list (prices) every minute through the cached function.
  const cbHistory = new CoinbasePriceHistory();
  const pollCoinbase = async () => {
    const direct = "https://api.coinbase.com/api/v3/brokerage/market/products?product_type=SPOT";
    try {
      let r;
      try {
        // Straight from the browser first: the visitor's own IP, no rate limit shared with other Cloudflare users.
        r = await fetchText(direct, { timeoutMs: 20_000 });
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      } catch {
        r = await fetchText("/api/coinbase/products", { timeoutMs: 20_000 });
      }
      if (r.status !== 200) throw new Error(`HTTP ${r.status}${r.headers.get("x-upstream-status") ? ` (Coinbase a répondu ${r.headers.get("x-upstream-status")})` : ""}`);
      svc.onCoinbaseProducts(parseProductsPage(JSON.parse(r.text)).products, cbHistory);
    } catch (err) {
      svc.setSourceState("coinbase", "down", `liste Coinbase indisponible : ${(err as Error).message}`);
    }
  };

  // Coinbase perpetual contracts: the site lists them itself (all markets visible even before the bot answers).
  // Straight from the browser first (own IP), then through the site's cached proxy when there is one.
  const perpGet = async (url: string, proxy?: string) => {
    try {
      const r = await fetchText(url, { timeoutMs: 6_000 });
      if (r.status === 200) return r.text;
      if (!proxy) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      if (!proxy) throw e;
    }
    const r = await fetchText(proxy as string, { timeoutMs: 15_000 });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}${r.headers.get("x-upstream-status") ? ` (a répondu ${r.headers.get("x-upstream-status")})` : ""}`);
    return r.text;
  };
  let perpsTried = false;
  const pollPerps = async () => {
    const r = await loadPerpMarkets(perpGet, () => svc.perpsFromDerivatives());
    perpsTried = true;
    svc.setPerpDiagnostics(r.sources, r.errors);
    if (r.markets.length) svc.onPerps(r.markets, new Map());
    void refreshLeverage();
  };
  void pollPerps();
  setInterval(() => void pollPerps(), 120_000);

  // Leveraged markets shown on the page: the bot's reading when fresh (richer: long/short ratio, buy flow),
  // else this page's own reading. Cached (and kept in the browser) so the page opens instantly.
  const LEV_STORE = "crypto-radar-leverage-v1";
  const levCache: { data: { at: number | null; markets: unknown[]; origin: string; cached?: boolean } | null; fetchedAt: number } = { data: null, fetchedAt: 0 };
  try {
    const raw = localStorage.getItem(LEV_STORE);
    if (raw) levCache.data = { ...(JSON.parse(raw) as { at: number | null; markets: unknown[]; origin: string }), cached: true };
  } catch {
    // no storage
  }
  let levRefreshing: Promise<void> | null = null;
  const refreshLeverage = () =>
    (levRefreshing ??= (async () => {
      try {
        const bot = await botGet<{ at: number | null; markets: unknown[] }>("/api/discord/leverage");
        const local = svc.leverage();
        const next = bot?.at && bot.markets.length && Date.now() - bot.at < 15 * 60_000 ? { ...bot, origin: "bot" } : local.markets.length ? { ...local, origin: "site" } : perpsTried ? { ...local, origin: "site", tried: true } : null;
        if (next) {
          levCache.data = next;
          try {
            localStorage.setItem(LEV_STORE, JSON.stringify(next));
          } catch {
            // quota / private mode
          }
        }
        levCache.fetchedAt = Date.now();
      } finally {
        levRefreshing = null;
      }
    })());

  // ── Relay to the Discord bot: the site's signals (Binance real time…) go straight to Discord.
  const readKey = () => {
    try {
      return localStorage.getItem(RELAY_KEY_STORE) || "";
    } catch {
      return "";
    }
  };
  const relay = { sent: 0, rejected: 0, lastOkAt: null as number | null, lastError: null as string | null, queued: 0, rejectReasons: {} as Record<string, number> };
  type Relayed = { id: string; ts: number; [k: string]: unknown };
  // Kept in this browser: a signal waiting for Discord survives a reload or a closed tab (40 min max).
  const QUEUE_STORE = "crypto-radar-relay-queue-v1";
  const MARKS_STORE = "crypto-radar-discord-marks-v1";
  let relayQueue: Relayed[] = [];
  /** Signal id → what happened on Discord ("sent", "dup", "filtered", "queued", "nokey"…). */
  const marks = new Map<string, string>();
  try {
    relayQueue = (JSON.parse(localStorage.getItem(QUEUE_STORE) ?? "[]") as Relayed[]).filter((x) => Date.now() - x.ts < 40 * 60_000);
    for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(MARKS_STORE) ?? "{}") as Record<string, string>)) marks.set(k, v);
  } catch {
    // no storage
  }
  const saveRelay = () => {
    try {
      localStorage.setItem(QUEUE_STORE, JSON.stringify(relayQueue.slice(-1500)));
      localStorage.setItem(MARKS_STORE, JSON.stringify(Object.fromEntries([...marks].slice(-3000))));
    } catch {
      // quota / private mode
    }
  };
  let relayPauseUntil = 0;
  let sending = false;
  // EVERY signal shown on the site goes into the queue — even before the relay code is entered:
  // the backlog (up to 40 min) is sent as soon as the code is activated.
  svc.subscribe((b) => {
    // The official trend verdict is the bot's: this page's own opinions stay on the site.
    for (const s of b.signals) marks.set(s.id, s.source === "verdict" ? "local" : "queued");
    for (const s of b.signals.filter((x) => x.source !== "verdict")) relayQueue.push({ id: s.id, ts: s.ts, coin: s.coin, coinName: s.coinName, kind: s.kind, direction: s.direction, source: s.source, strength: s.strength, title: s.title, reasons: s.reasons.slice(0, 10), priceUsd: s.priceUsd, url: s.url, metrics: s.metrics });
  });
  /** The site holds the relay code itself (RELAY_KEY on the Pages project): no code to type on this device. */
  let autoRelay = false;
  const canRelay = () => !!readKey() || autoRelay;
  const postRelay = async (signals: unknown[], key = readKey()) => {
    const r = await fetchText("/api/discord/relay", { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-relay-key": key } : {}) }, body: JSON.stringify({ signals }), timeoutMs: 20_000 });
    const body = (() => {
      try {
        return JSON.parse(r.text) as { ok?: boolean; error?: string; accepted?: number; rejected?: number; reasons?: Record<string, number>; results?: Record<string, string> };
      } catch {
        return {};
      }
    })();
    if (r.status !== 200 || !body.ok) throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), { status: r.status });
    return body;
  };
  const pumpRelay = async () => {
    const now = Date.now();
    relayQueue = relayQueue.filter((x) => now - x.ts < 40 * 60_000).slice(-2000);
    relay.queued = relayQueue.length;
    if (sending || !relayQueue.length || now < relayPauseUntil || !canRelay()) return;
    sending = true;
    const batch = relayQueue.slice(0, 100);
    try {
      const b = await postRelay(batch);
      // Only remove what was actually delivered to the bot.
      const sentIds = new Set(batch.map((x) => x.id));
      relayQueue = relayQueue.filter((x) => !sentIds.has(x.id));
      for (const x of batch) marks.set(x.id, b.results?.[x.id] ?? "sent");
      saveRelay();
      relay.sent += b.accepted ?? 0;
      relay.rejected += b.rejected ?? 0;
      for (const [k, v] of Object.entries(b.reasons ?? {})) relay.rejectReasons[k] = (relay.rejectReasons[k] ?? 0) + v;
      relay.lastOkAt = Date.now();
      relay.lastError = null;
    } catch (e) {
      // Kept in the queue and retried: network hiccup, bot busy, Discord limits…
      const status = (e as { status?: number }).status;
      relay.lastError = (e as Error).message;
      relayPauseUntil = Date.now() + (status === 401 ? 60_000 : 10_000);
    } finally {
      sending = false;
      relay.queued = relayQueue.length;
    }
  };
  setInterval(() => void pumpRelay(), 2000);
  setInterval(saveRelay, 15_000);
  window.addEventListener("pagehide", saveRelay);
  /** Discord status of a signal shown on this page. */
  const markOf = (id: string): string | null => {
    const m = marks.get(id);
    if (m === "queued" && !canRelay()) return "nokey";
    return m ?? null;
  };
  let botStatus: unknown = null;
  const pollBot = () =>
    fetchText("/api/discord/status", { timeoutMs: 15_000 }).then(
      (r) => {
        try {
          botStatus = JSON.parse(r.text);
        } catch {
          botStatus = { error: `HTTP ${r.status}` };
        }
        autoRelay = !!(botStatus as { autoRelay?: boolean }).autoRelay;
        const b = botStatus as { configured?: boolean; error?: string; status?: { lastRunAt?: number; config?: { webhookConfigured?: boolean }; discord?: Record<string, unknown> } };
        const last = b.status?.lastRunAt ?? null;
        const channels = Object.keys(b.status?.discord ?? {}).length;
        if (!b.configured) svc.setSourceState("discord", "waiting", "ajoute DISCORD_WORKER_URL au site pour afficher l'état du bot");
        else if (b.error) svc.setSourceState("discord", "down", b.error);
        else if (!b.status?.config?.webhookConfigured) svc.setSourceState("discord", "degraded", "bot en ligne mais aucun webhook valide configuré");
        else if (last && Date.now() - last < 3 * 60_000) svc.setSourceState("discord", "ok", `bot actif · ${channels} salon(s) · dernière analyse il y a ${Math.max(1, Math.round((Date.now() - last) / 1000))} s${canRelay() ? ` · relais du site activé${readKey() ? "" : " (automatique)"}` : ""}`, last);
        else svc.setSourceState("discord", "degraded", last ? "le bot n'a pas tourné depuis plus de 3 min" : "le bot n'a pas encore tourné");
      },
      (e: Error) => (botStatus = { error: e.message }),
    );
  void pollBot();
  setInterval(() => void pollBot(), 30_000);

  // ── Binance Futures liquidations (live, from the browser). Since 2026 the futures streams are split
  // by category (/public, /market, /private); the right one for forceOrder is tried first, then the others.
  const LIQ_URLS = ["wss://fstream.binance.com/market/ws/!forceOrder@arr", "wss://fstream.binance.com/public/ws/!forceOrder@arr", "wss://fstream.binance.com/ws/!forceOrder@arr"];
  let liqIdx = 0;
  let liqBuf: { symbol: string; side: "BUY" | "SELL"; usd: number; ts: number }[] = [];
  const connectLiq = () => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(LIQ_URLS[liqIdx % LIQ_URLS.length] as string);
    } catch {
      return;
    }
    let got = false;
    // Liquidations happen every few seconds market-wide: 90 s of silence = wrong endpoint.
    const silence = setTimeout(() => {
      if (!got) {
        liqIdx++;
        ws.close();
      }
    }, 90_000);
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as { o?: { s?: string; S?: string; q?: string; ap?: string; p?: string; T?: number } };
        const o = m.o;
        if (!o?.s || (o.S !== "BUY" && o.S !== "SELL")) return;
        const usd = Number(o.q) * Number(o.ap || o.p);
        if (!Number.isFinite(usd)) return;
        got = true;
        liqBuf.push({ symbol: o.s, side: o.S, usd, ts: o.T ?? Date.now() });
      } catch {
        // ignore
      }
    };
    ws.onclose = () => {
      clearTimeout(silence);
      setTimeout(connectLiq, got ? 5000 : 15_000);
    };
  };
  connectLiq();
  setInterval(() => {
    if (!liqBuf.length) return;
    const b = liqBuf;
    liqBuf = [];
    svc.onLiquidations(b);
  }, 5000);

  // ── The 24/7 bot: its own signals (listings, leverage, Coinbase…) are shown here too.
  const botGet = async <T>(path: string): Promise<T | null> => {
    try {
      const r = await fetchText(path, { timeoutMs: 20_000 });
      return r.status === 200 ? (JSON.parse(r.text) as T) : null;
    } catch {
      return null;
    }
  };
  let botSince = Date.now() - 3 * 3_600_000;
  const pullBotSignals = async () => {
    const r = await botGet<{ signals: (import("@radar/core").IntelSignal & { discord?: string | null })[] }>(`/api/discord/signals?since=${botSince}`);
    if (!r?.signals?.length) return;
    // Same event from the same source already detected by this page within 30 min → one card
    // (it carries the bot's Discord status when the bot sent it). Other sources are all shown.
    const mine = svc.engine.recentSignals({ since: Date.now() - 3 * 3_600_000, limit: 5000 });
    const localIds = new Set(mine.map((m) => m.id));
    const fresh = r.signals.filter((b) => {
      // A signal this page relayed comes back as "site-<id>": it carries its Discord status to the local card.
      if (b.id.startsWith("site-")) {
        const local = b.id.slice(5);
        if (localIds.has(local)) {
          if (b.discord) marks.set(local, b.discord);
          return false;
        }
        // Relayed by another device (phone, other browser): shown here too.
        b.reasons = [...b.reasons, "relayé depuis un autre appareil"];
      }
      if (b.discord) marks.set(`bot-${b.id}`, b.discord);
      const twin = mine.find((m) => m.coin === b.coin && m.kind === b.kind && m.direction === b.direction && m.source === b.source && Math.abs(m.ts - b.ts) < 30 * 60_000);
      if (twin && b.discord === "sent" && marks.get(twin.id) !== "sent") marks.set(twin.id, "sent");
      return !twin;
    });
    svc.engine.addExternal(fresh.map((x) => ({ ...x, id: `bot-${x.id}`, reasons: x.id.startsWith("site-") ? x.reasons : [...x.reasons, "détecté par le bot 24 h/24"] })));
    botSince = Math.max(botSince, ...r.signals.map((x) => x.ts));
  };
  void pullBotSignals();
  setInterval(() => void pullBotSignals(), 15_000);

  // ── Trader setups: one coin every 8 s (1 h candles straight from Binance / Coinbase, from this browser).
  const directGet = async (url: string) => {
    const r = await fetchText(url, { timeoutMs: 12_000 });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    return r.text;
  };
  const btc = { trend: null as number | null, at: 0 };
  let setupTurn = 0;
  let setupBusy = false;
  const setupTick = async () => {
    if (setupBusy) return;
    setupBusy = true;
    try {
      const refreshBtc = Date.now() - btc.at > 15 * 60_000;
      const coins = svc.setupUniverse(60);
      const coin = refreshBtc ? "BTC" : coins[setupTurn++ % Math.max(1, coins.length)];
      if (!coin) return;
      const r = await runSetup(directGet, svc, coin, { btcTrend: btc.trend });
      if (coin === "BTC") Object.assign(btc, { trend: r.trend, at: Date.now() });
    } catch {
      // coin without candles on Binance / Coinbase: next one
    } finally {
      setupBusy = false;
    }
  };
  // Fast first pass (one coin every 3 s until 60 are known), then one every 10 s.
  const setupLoop = () => {
    void setupTick().finally(() => setTimeout(setupLoop, svc.setups().count < 60 ? 3_000 : 10_000));
  };
  setTimeout(setupLoop, 8_000);
  // The bot's setups (it analyses around the clock) complete this page's own.
  const botSetups: { data: { setups: SetupView[] } | null; at: number } = { data: null, at: 0 };
  const mergedSetups = async (bias?: string) => {
    if (Date.now() - botSetups.at > 60_000) {
      botSetups.at = Date.now();
      botSetups.data = await botGet<{ setups: SetupView[] }>("/api/discord/setups");
    }
    const mine = svc.setups({ bias });
    const byCoin = new Map<string, SetupView & { origin: string }>();
    for (const x of botSetups.data?.setups ?? []) if (!bias || x.setup.bias === bias) byCoin.set(x.coin, { ...x, origin: "bot" });
    for (const x of mine.setups) {
      const b = byCoin.get(x.coin);
      if (!b || x.at >= b.at) byCoin.set(x.coin, { ...x, origin: "site" });
    }
    const list = [...byCoin.values()]
      .filter((x) => Date.now() - x.at < 3 * 3_600_000)
      .sort((a, b) => (a.setup.bias === "WAIT" ? 1 : 0) - (b.setup.bias === "WAIT" ? 1 : 0) || b.setup.confidence - a.setup.confidence);
    return { at: list.length ? Math.max(...list.map((x) => x.at)) : null, count: list.length, setups: list, btcTrend: btc.trend };
  };
  // Chart ranges → candle interval and count.
  const RANGES: Record<string, [CandleInterval, number]> = { "1h": ["1m", 60], "1d": ["5m", 288], "1w": ["1h", 168], "1m": ["4h", 180], "1y": ["1d", 365] };

  // ── Demo account (fake money), kept in this browser. Prices: the live feed first, else the last candle.
  const DEMO_STORE = "crypto-radar-demo-account-v1";
  let demo: DemoState = (() => {
    try {
      return loadDemo(JSON.parse(localStorage.getItem(DEMO_STORE) ?? "null"), Date.now());
    } catch {
      return createDemo(Date.now());
    }
  })();
  let demoEvents: { ts: number; text: string }[] = [];
  const saveDemo = () => {
    try {
      localStorage.setItem(DEMO_STORE, JSON.stringify(demo));
    } catch {
      // quota / private mode: the account lives until the tab is closed
    }
  };
  const fallbackPx = new Map<string, { price: number; at: number }>();
  const fetchingPx = new Set<string>();
  const refreshFallback = (coin: string) => {
    if (fetchingPx.has(coin)) return;
    fetchingPx.add(coin);
    void loadCandles(directGet, coin, "1m", 3, { extraBase: "" })
      .then((r) => {
        const c = r.candles.at(-1);
        if (c) fallbackPx.set(coin, { price: c.c, at: Date.now() });
      })
      .catch(() => {})
      .finally(() => fetchingPx.delete(coin));
  };
  const demoPrice = (coin: string): number | null => {
    const row = svc.engine.coin(coin);
    const live = row?.live && Date.now() - row.live.updatedAt < 120_000 ? row.live.price : null;
    if (live) return live;
    const f = fallbackPx.get(coin);
    if (!f || Date.now() - f.at > 30_000) refreshFallback(coin);
    return f?.price ?? row?.priceUsd ?? null;
  };
  /** Current price of a coin for an order: waits for a fresh one when this page has none yet. */
  const orderPrice = async (coin: string): Promise<number | null> => {
    const p = demoPrice(coin);
    if (p) return p;
    try {
      const r = await loadCandles(directGet, coin, "1m", 3, { extraBase: "" });
      const c = r.candles.at(-1);
      if (c) fallbackPx.set(coin, { price: c.c, at: Date.now() });
      return c?.c ?? null;
    } catch {
      return null;
    }
  };
  setInterval(() => {
    const held = [...Object.keys(demo.spot), ...demo.positions.map((p) => p.coin)];
    if (!held.length && demo.deposited === 0) return;
    const r = tickDemo(demo, demoPrice, Date.now());
    demo = r.state;
    if (r.events.length) demoEvents = [...r.events.map((text) => ({ ts: Date.now(), text })), ...demoEvents].slice(0, 20);
    saveDemo();
  }, 5_000);
  const demoView = () => ({ state: demo, valuation: valueDemo(demo, demoPrice), events: demoEvents });

  const save = () => {
    const st = svc.exportState({ cgLastRun: cg.lastRuns() });
    let keep = 4000;
    for (;;) {
      try {
        const compact = { ...st, tracker: st.tracker.slice(-keep), engine: { signals: st.engine.signals.slice(-Math.min(3000, keep)), news: st.engine.news.slice(-Math.min(400, keep)) } };
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
  // Give Binance a head start so coins it streams are not duplicated by Coinbase.
  setTimeout(() => {
    void pollCoinbase();
    setInterval(() => void pollCoinbase(), 60_000);
  }, 20_000);
  setInterval(() => void pollNews(), NEWS_EVERY_MS);
  setInterval(() => svc.tickOutcomes(), 30_000);
  setInterval(save, 60_000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && save());
  window.addEventListener("pagehide", save);

  const startedAt = Date.now();
  const ctx = {
    log,
    intel: svc,
    intelExtras: () => ({ web: true, simulated: false, coingecko: null, binanceFeed: binance.status(), newsFeeds, discordWorker: botStatus, relay: { keySet: !!readKey(), autoRelay, ...relay } }),
    publicConfig: () => ({ mode: "WEB" }),
    startedAt,
  } as unknown as RouteContext;
  emit({ type: "SYSTEM_STARTED", level: "info", success: true, message: "Site live : analyse multi-sources démarrée dans le navigateur" });

  return {
    async get(path) {
      const u = new URL(path, "https://site.local");
      // Data owned by the 24/7 bot (leveraged markets, long-term statistics, Discord settings).
      if (u.pathname === "/api/intel/leverage") {
        // Instant answer from the cache (memory, or this browser's last visit); refreshed in the background.
        if (Date.now() - levCache.fetchedAt > 20_000) void refreshLeverage();
        if (levCache.data) return levCache.data;
        await refreshLeverage();
        return levCache.data ?? { at: null, markets: [], context: svc.marketContext(), origin: "site", unavailable: true };
      }
      if (u.pathname === "/api/intel/feed") {
        const r = handleGet(ctx, u.pathname, u.searchParams);
        if (!r || r.status >= 400) throw new Error(`${path} → ${r?.status ?? 404}`);
        const body = r.body as { signals: { id: string }[] };
        return { ...body, signals: body.signals.map((x) => ({ ...x, discord: markOf(x.id) })), discordKey: !!readKey() };
      }
      if (u.pathname === "/api/web/demo") return demoView();
      if (u.pathname === "/api/web/price") {
        const coin = (u.searchParams.get("coin") ?? "").toUpperCase();
        if (!/^[A-Z0-9]{1,20}$/.test(coin)) throw new Error("crypto invalide");
        const row = svc.engine.coin(coin);
        return { coin, price: await orderPrice(coin), name: row?.name ?? null, change24h: row?.change24h ?? null, maxLeverage: svc.setupContext(coin).maxLeverage };
      }
      if (u.pathname === "/api/intel/verdicts") {
        // The bot's opinions (official, 24/7) first; this page's own fill the gaps.
        const bot = await botGet<{ verdicts: { coin: string; evaluatedAt: number }[] }>("/api/discord/verdicts");
        const mine = svc.verdictBoard();
        const byCoin = new Map<string, unknown>();
        for (const v of mine.verdicts) byCoin.set(v.coin, { ...v, origin: "site" });
        for (const v of bot?.verdicts ?? []) if (Date.now() - v.evaluatedAt < 3 * 3_600_000) byCoin.set(v.coin, { ...v, origin: "bot" });
        const list = [...byCoin.values()] as { state: string; score: number }[];
        list.sort((a, b) => (a.state === "NEUTRAL" ? 1 : 0) - (b.state === "NEUTRAL" ? 1 : 0) || Math.abs(b.score) - Math.abs(a.score));
        return { count: list.length, verdicts: list, botOnline: !!bot };
      }
      if (u.pathname === "/api/intel/setups") return mergedSetups(u.searchParams.get("bias") ?? undefined);
      if (u.pathname === "/api/web/candles") {
        const coin = (u.searchParams.get("coin") ?? "").toUpperCase();
        const range = RANGES[u.searchParams.get("range") ?? "1d"];
        if (!/^[A-Z0-9]{1,20}$/.test(coin) || !range) throw new Error("paramètres invalides");
        const src = u.searchParams.get("src") ?? "auto";
        if (!/^[a-z]{2,10}$/.test(src)) throw new Error("source invalide");
        return loadCandles(directGet, coin, range[0], range[1], { extraBase: "", only: src });
      }
      if (u.pathname === "/api/web/setup") {
        const coin = (u.searchParams.get("coin") ?? "").toUpperCase();
        if (!/^[A-Z0-9]{1,20}$/.test(coin)) throw new Error("crypto invalide");
        const r = await runSetup(directGet, svc, coin, { btcTrend: coin === "BTC" ? null : btc.trend, emit: false, extraBase: "" });
        return { coin, setup: r.setup, source: r.source, context: svc.setupContext(coin) };
      }
      if (u.pathname === "/api/intel/performance" && u.searchParams.get("scope") === "bot") {
        const r = await botGet("/api/discord/stats");
        if (!r) throw new Error("statistiques du bot indisponibles (DISCORD_WORKER_URL ?)");
        return r;
      }
      if (u.pathname === "/api/web/prefs") {
        const r = await botGet("/api/discord/prefs");
        if (!r) throw new Error("bot injoignable : vérifie DISCORD_WORKER_URL sur le site");
        return { ...(r as object), keySet: !!readKey() };
      }
      const r = handleGet(ctx, u.pathname, u.searchParams);
      if (!r || r.status >= 400) throw new Error(`${path} → ${r?.status ?? 404}`);
      return r.body;
    },
    async post(path, body) {
      if (path === "/api/web/demo") {
        // Paper trading only: nothing here can reach an exchange.
        const a = (body ?? {}) as Record<string, unknown>;
        const now = Date.now();
        const coin = typeof a.coin === "string" ? a.coin.toUpperCase() : "";
        let r: DemoResult;
        switch (a.action) {
          case "deposit":
            r = demoDeposit(demo, Number(a.amount), now);
            break;
          case "buy": {
            const px = await orderPrice(coin);
            r = px ? demoBuy(demo, coin, Number(a.usd), px, now) : { ok: false, error: `pas de prix pour ${coin}` };
            break;
          }
          case "sell": {
            const px = await orderPrice(coin);
            r = px ? demoSell(demo, coin, Number(a.fraction), px, now) : { ok: false, error: `pas de prix pour ${coin}` };
            break;
          }
          case "open": {
            const px = await orderPrice(coin);
            const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
            r = px
              ? demoOpen(demo, { coin, side: a.side === "SHORT" ? "SHORT" : "LONG", leverage: Number(a.leverage), margin: Number(a.margin), price: px, stop: num(a.stop), takeProfit: num(a.takeProfit), maxLeverage: svc.setupContext(coin).maxLeverage }, now)
              : { ok: false, error: `pas de prix pour ${coin}` };
            break;
          }
          case "close": {
            const pos = demo.positions.find((p) => p.id === a.id);
            const px = pos ? await orderPrice(pos.coin) : null;
            r = pos && px ? demoClose(demo, pos.id, px, now) : { ok: false, error: "position ou prix introuvable" };
            break;
          }
          case "reset":
            if (a.confirm !== "RESET") return { status: 400, body: { ok: false, error: "confirmation manquante" } };
            r = { ok: true, state: createDemo(now), message: "Compte de démo remis à zéro" };
            demoEvents = [];
            break;
          default:
            return { status: 400, body: { ok: false, error: "action inconnue" } };
        }
        if (!r.ok) return { status: 400, body: { ok: false, error: r.error } };
        demo = r.state;
        saveDemo();
        return { status: 200, body: { ok: true, message: r.message, ...demoView() } };
      }
      if (path === "/api/web/test-channels") {
        const key = readKey();
        if (!key) return { status: 400, body: { ok: false, error: "entre d'abord ton code de relais (page Sources → carte Discord)" } };
        const r = await fetchText("/api/discord/test-channels", { method: "POST", headers: { "content-type": "application/json", "x-relay-key": key }, body: "{}", timeoutMs: 30_000 });
        let b: unknown = {};
        try {
          b = JSON.parse(r.text);
        } catch {
          b = { ok: false, error: `HTTP ${r.status}` };
        }
        return { status: r.status, body: b };
      }
      if (path === "/api/web/prefs") {
        const key = readKey();
        if (!key) return { status: 400, body: { ok: false, error: "entre d'abord ton code de relais (page Sources → carte Discord)" } };
        const r = await fetchText("/api/discord/prefs", { method: "POST", headers: { "content-type": "application/json", "x-relay-key": key }, body: JSON.stringify(body), timeoutMs: 15_000 });
        let b: unknown = {};
        try {
          b = JSON.parse(r.text);
        } catch {
          b = { ok: false, error: `HTTP ${r.status}` };
        }
        return { status: r.status, body: b };
      }
      if (path === "/api/web/relay-key") {
        // Save the relay code in this browser after checking it with the bot (empty batch = no message).
        const key = String((body as { key?: string })?.key ?? "").trim();
        try {
          if (!key) localStorage.removeItem(RELAY_KEY_STORE);
          else {
            await postRelay([], key);
            localStorage.setItem(RELAY_KEY_STORE, key);
          }
          relay.lastError = null;
          return { status: 200, body: { ok: true, message: key ? "Code accepté par le bot : les signaux du site partent maintenant sur Discord." : "Relais désactivé sur ce navigateur." } };
        } catch (e) {
          return { status: 400, body: { ok: false, error: (e as Error).message } };
        }
      }
      const r = await handleAction(ctx, new URL(path, "https://site.local").pathname, body);
      return { status: r.status, body: r.body };
    },
    subscribe(onEvent) {
      const offIntel = svc.subscribe((b) => onEvent("intel", { ...b, signals: b.signals.map((x) => ({ ...x, discord: markOf(x.id) })) }));
      const offLog = log.subscribe((e: LogEvent) => e.level !== "debug" && onEvent("log", e));
      onEvent("status", null);
      return () => {
        offIntel();
        offLog();
      };
    },
  };
}

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
import { CoinbasePriceHistory, IntelConfigSchema, parseFeed, parseProductsPage, type LogEvent } from "@radar/core";
import { handleAction, handleGet, type RouteContext } from "../../server/src/api/routes";
import { BinanceFeed } from "../../server/src/intel/binance-feed";
import { CallBudget } from "../../server/src/intel/budget";
import { CoinGeckoFeed } from "../../server/src/intel/coingecko-feed";
import { fetchText, type FetchText } from "../../server/src/intel/http";
import { IntelService, type IntelSavedState } from "../../server/src/intel/intel-service";
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
  const svc = new IntelService({ cfg, log: emit, notifier: null, enabledSources: ["binance", "coinbase", "coingecko", "trending", "derivatives", "dex", "news", "social", "leverage", "discord"] });
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

  // ── Relay to the Discord bot: the site's signals (Binance real time…) go straight to Discord.
  const readKey = () => {
    try {
      return localStorage.getItem(RELAY_KEY_STORE) || "";
    } catch {
      return "";
    }
  };
  const relay = { sent: 0, lastOkAt: null as number | null, lastError: null as string | null };
  let relayQueue: unknown[] = [];
  // Every signal shown on the site is relayed (no strength threshold).
  svc.subscribe((b) => {
    if (!readKey()) return;
    for (const s of b.signals) relayQueue.push({ id: s.id, ts: s.ts, coin: s.coin, coinName: s.coinName, kind: s.kind, direction: s.direction, source: s.source, strength: s.strength, title: s.title, reasons: s.reasons.slice(0, 8), priceUsd: s.priceUsd, url: s.url });
  });
  const postRelay = async (signals: unknown[], key = readKey()) => {
    const r = await fetchText("/api/discord/relay", { method: "POST", headers: { "content-type": "application/json", "x-relay-key": key }, body: JSON.stringify({ signals }), timeoutMs: 15_000 });
    const body = (() => {
      try {
        return JSON.parse(r.text) as { ok?: boolean; error?: string; accepted?: number };
      } catch {
        return {};
      }
    })();
    if (r.status !== 200 || !body.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    return body;
  };
  setInterval(() => {
    if (!relayQueue.length) return;
    const batch = relayQueue.splice(0, 50);
    if (relayQueue.length > 1000) relayQueue = relayQueue.slice(-1000);
    postRelay(batch).then(
      (b) => {
        relay.sent += b.accepted ?? 0;
        relay.lastOkAt = Date.now();
        relay.lastError = null;
      },
      (e: Error) => (relay.lastError = e.message),
    );
  }, 2000);
  let botStatus: unknown = null;
  const pollBot = () =>
    fetchText("/api/discord/status", { timeoutMs: 15_000 }).then(
      (r) => {
        try {
          botStatus = JSON.parse(r.text);
        } catch {
          botStatus = { error: `HTTP ${r.status}` };
        }
        const b = botStatus as { configured?: boolean; error?: string; status?: { lastRunAt?: number; config?: { webhookConfigured?: boolean }; discord?: Record<string, unknown> } };
        const last = b.status?.lastRunAt ?? null;
        const channels = Object.keys(b.status?.discord ?? {}).length;
        if (!b.configured) svc.setSourceState("discord", "waiting", "ajoute DISCORD_WORKER_URL au site pour afficher l'état du bot");
        else if (b.error) svc.setSourceState("discord", "down", b.error);
        else if (!b.status?.config?.webhookConfigured) svc.setSourceState("discord", "degraded", "bot en ligne mais aucun webhook valide configuré");
        else if (last && Date.now() - last < 3 * 60_000) svc.setSourceState("discord", "ok", `bot actif · ${channels} salon(s) · dernière analyse il y a ${Math.max(1, Math.round((Date.now() - last) / 1000))} s${readKey() ? " · relais du site activé" : ""}`, last);
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
    const r = await botGet<{ signals: import("@radar/core").IntelSignal[] }>(`/api/discord/signals?since=${botSince}`);
    if (!r?.signals?.length) return;
    // Same event already detected by this page within 30 min → keep one card.
    const mine = svc.engine.recentSignals({ since: Date.now() - 3 * 3_600_000, limit: 5000 });
    const fresh = r.signals.filter((b) => !mine.some((m) => m.coin === b.coin && m.kind === b.kind && m.direction === b.direction && Math.abs(m.ts - b.ts) < 30 * 60_000));
    svc.engine.addExternal(fresh.map((x) => ({ ...x, id: `bot-${x.id}`, reasons: [...x.reasons, "détecté par le bot 24 h/24"] })));
    botSince = Math.max(botSince, ...r.signals.map((x) => x.ts));
  };
  void pullBotSignals();
  setInterval(() => void pullBotSignals(), 30_000);

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
    intelExtras: () => ({ web: true, simulated: false, coingecko: null, binanceFeed: binance.status(), newsFeeds, discordWorker: botStatus, relay: { keySet: !!readKey(), ...relay } }),
    publicConfig: () => ({ mode: "WEB" }),
    startedAt,
  } as unknown as RouteContext;
  emit({ type: "SYSTEM_STARTED", level: "info", success: true, message: "Site live : analyse multi-sources démarrée dans le navigateur" });

  return {
    async get(path) {
      const u = new URL(path, "https://site.local");
      // Data owned by the 24/7 bot (leveraged markets, long-term statistics, Discord settings).
      if (u.pathname === "/api/intel/leverage") return (await botGet("/api/discord/leverage")) ?? { at: null, markets: [], context: svc.marketContext(), unavailable: true };
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

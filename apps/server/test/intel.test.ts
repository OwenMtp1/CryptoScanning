import { afterEach, describe, expect, it, vi } from "vitest";
import { CgMarketRowSchema, IntelConfigSchema, defaultIntelConfig, type IntelSignal } from "@radar/core";
import { handleAction, handleGet, type RouteContext } from "../src/api/routes.js";
import { BinanceFeed } from "../src/intel/binance-feed.js";
import { CallBudget } from "../src/intel/budget.js";
import { CoinGeckoFeed } from "../src/intel/coingecko-feed.js";
import { DiscordNotifier, isDiscordWebhookUrl } from "../src/intel/discord-notifier.js";
import type { FetchText, HttpResponse } from "../src/intel/http.js";
import { IntelService } from "../src/intel/intel-service.js";
import { NewsPoller } from "../src/intel/news-poller.js";
import type { WsLike } from "../src/market-data/coinbase-ws.js";

const T0 = Date.UTC(2026, 8, 10, 12, 0, 0);
const resp = (status: number, text = "", headers: Record<string, string> = {}): HttpResponse => ({ status, text, headers: { get: (n) => headers[n.toLowerCase()] ?? null } });
const noLog = () => {};

const marketRow = (symbol: string, o: Record<string, unknown> = {}) => ({
  id: symbol.toLowerCase(),
  symbol: symbol.toLowerCase(),
  name: `${symbol} Coin`,
  current_price: 10,
  market_cap: 5e9,
  market_cap_rank: 10,
  total_volume: 2e8,
  price_change_percentage_1h_in_currency: 0.2,
  price_change_percentage_24h_in_currency: 1,
  price_change_percentage_7d_in_currency: 2,
  ath_change_percentage: -40,
  ...o,
});

describe("CallBudget", () => {
  it("enforces monthly and per-minute limits and resets each month", () => {
    const b = new CallBudget(3, 2, null, T0);
    expect(b.tryAcquire(T0)).toBe(true);
    expect(b.tryAcquire(T0)).toBe(true);
    expect(b.tryAcquire(T0)).toBe(false); // per minute
    expect(b.tryAcquire(T0 + 61_000)).toBe(true);
    expect(b.tryAcquire(T0 + 200_000)).toBe(false); // monthly
    const next = Date.UTC(2026, 9, 1, 0, 1);
    expect(b.tryAcquire(next)).toBe(true);
    expect(b.view(next)).toMatchObject({ month: "2026-10", used: 1 });
  });
  it("paces the remaining quota over the rest of the month", () => {
    const b = new CallBudget(10_000, 30, { month: "2026-09", used: 0 }, T0);
    // 20.5 days left (492 h) → 10 000 × 0.9 / 492 ≈ 18.29 calls/h
    expect(b.allowedPerHour(T0)).toBeCloseTo(9000 / 492, 6);
    expect(new CallBudget(10, 30, { month: "2026-08", used: 10 }, T0).remaining(T0)).toBe(10);
  });
});

describe("CoinGeckoFeed", () => {
  const cfg = defaultIntelConfig().coingecko;
  const handlers = () => ({ onMarkets: vi.fn(), onTrending: vi.fn(), onDerivatives: vi.fn(), onPools: vi.fn(), onError: vi.fn(), onSuccess: vi.fn() });

  it("sends the demo key header, parses rows and skips invalid ones", async () => {
    const calls: { url: string; headers?: Record<string, string> }[] = [];
    const fetchText: FetchText = async (url, init) => {
      calls.push({ url, headers: init?.headers });
      return resp(200, JSON.stringify([marketRow("AAA"), { bad: true }]));
    };
    const h = handlers();
    const feed = new CoinGeckoFeed({ plan: "demo", apiKey: "CG-test", cfg: { ...cfg, universeSize: 250, dex: { ...cfg.dex, enabled: false } }, budget: new CallBudget(10_000, 30, null, T0), fetchText, handlers: h, now: () => T0 });
    expect(await feed.tick()).toBe("markets:1");
    expect(calls[0]!.url).toContain("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd");
    expect(calls[0]!.url).toContain("price_change_percentage=1h%2C24h%2C7d");
    expect(calls[0]!.headers!["x-cg-demo-api-key"]).toBe("CG-test");
    expect(h.onMarkets.mock.calls[0]![0]).toHaveLength(1);
    expect(h.onSuccess).toHaveBeenCalledWith("markets:1", 1, T0);
  });
  it("uses the pro host and header for paid plans", () => {
    const feed = new CoinGeckoFeed({ plan: "pro", apiKey: "k", cfg, budget: new CallBudget(1, 1, null, T0), fetchText: async () => resp(200), handlers: handlers() });
    expect(feed.baseUrl).toBe("https://pro-api.coingecko.com/api/v3");
  });
  it("stretches intervals to fit the budget and stops when it is exhausted", async () => {
    let now = T0;
    const fetchText = vi.fn(async () => resp(200, JSON.stringify({ coins: [] })));
    const budget = new CallBudget(10_000, 30, null, T0);
    const feed = new CoinGeckoFeed({ plan: "public", apiKey: null, cfg, budget, fetchText, handlers: handlers(), now: () => now });
    // 4 market pages + trending at 10 min, derivatives + dex×2 at 20 min = 39 calls/h vs ≈ 18.29 allowed
    expect(feed.stretch()).toBeCloseTo(39 / (9000 / 492), 6);
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const id = await feed.tick();
      if (id) seen.add(id);
      now += 15_000;
    }
    expect(seen.size).toBe(8); // every task ran once, one call per tick
    expect(await feed.tick()).toBeNull(); // nothing due yet
    const empty = new CoinGeckoFeed({ plan: "public", apiKey: null, cfg, budget: new CallBudget(10, 30, { month: "2026-09", used: 10 }, T0), fetchText, handlers: handlers(), now: () => T0 });
    expect(await empty.tick()).toBeNull();
  });
  it("backs off after a 429 and reports errors", async () => {
    let now = T0;
    const h = handlers();
    const feed = new CoinGeckoFeed({ plan: "public", apiKey: null, cfg, budget: new CallBudget(10_000, 30, null, T0), fetchText: async () => resp(429, "", { "retry-after": "120" }), handlers: h, now: () => now });
    await feed.tick();
    expect(h.onError.mock.calls[0]![1]).toContain("429");
    now += 60_000;
    expect(await feed.tick()).toBeNull();
    now += 61_000;
    expect(await feed.tick()).not.toBeNull();
  });
});

class FakeWs implements WsLike {
  readyState = 0;
  onopen: WsLike["onopen"] = null;
  onmessage: WsLike["onmessage"] = null;
  onclose: WsLike["onclose"] = null;
  onerror: WsLike["onerror"] = null;
  constructor(readonly url: string) {}
  send() {}
  close() {
    this.readyState = 3;
  }
}

describe("BinanceFeed", () => {
  afterEach(() => vi.useRealTimers());
  it("loads pairs, subscribes to the combined all-market streams and forwards changed coins", async () => {
    vi.useFakeTimers({ now: T0 });
    const sockets: FakeWs[] = [];
    const info = { symbols: [{ symbol: "PEPEUSDT", status: "TRADING", baseAsset: "PEPE", quoteAsset: "USDT", isSpotTradingAllowed: true }, { symbol: "OLDUSDT", status: "BREAK", baseAsset: "OLD", quoteAsset: "USDT" }, { symbol: "ETHBTC", status: "TRADING", baseAsset: "ETH", quoteAsset: "BTC" }] };
    const ticks: string[][] = [];
    const feed = new BinanceFeed({
      restUrl: "https://data-api.binance.vision",
      wsUrl: "wss://data-stream.binance.vision",
      quotes: ["USDT"],
      fetchText: async (url) => {
        expect(url).toBe("https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT");
        return resp(200, JSON.stringify(info));
      },
      wsFactory: (u) => {
        const w = new FakeWs(u);
        sockets.push(w);
        return w;
      },
      onTick: (_t, changed) => ticks.push([...changed]),
      onState: noLog,
    });
    await feed.start();
    expect(sockets[0]!.url).toBe("wss://data-stream.binance.vision/stream?streams=!miniTicker@arr/!ticker_1h@arr");
    sockets[0]!.readyState = 1;
    sockets[0]!.onopen?.({});
    feed.onMessage(JSON.stringify({ stream: "!miniTicker@arr", data: [{ e: "24hrMiniTicker", E: T0, s: "PEPEUSDT", c: "1", o: "1", h: "1", l: "1", v: "1", q: "1" }, { e: "24hrMiniTicker", E: T0, s: "OLDUSDT", c: "1", o: "1", h: "1", l: "1", v: "1", q: "1" }, { broken: 1 }] }));
    feed.flush();
    expect(ticks).toEqual([["PEPE"]]);
    expect(feed.status()).toMatchObject({ pairs: 1, decodeErrors: 1, connected: true });
    // watchdog: silence for > 60 s → reconnect
    vi.advanceTimersByTime(75_000);
    expect(sockets.length).toBe(2);
    feed.stop();
  });
});

describe("NewsPoller", () => {
  it("uses conditional GET and reports broken feeds", async () => {
    const feeds = [{ name: "A", url: "https://a.example/rss", lang: "en" as const }];
    const got: number[] = [];
    const errors: string[] = [];
    const seenHeaders: Record<string, string>[] = [];
    let n = 0;
    const rss = `<rss><channel><item><title>Solana surges</title><link>https://a.example/1</link></item></channel></rss>`;
    const poller = new NewsPoller({
      feeds,
      intervalSec: 300,
      fetchText: async (_u, init) => {
        seenHeaders.push(init?.headers ?? {});
        n++;
        if (n === 1) return resp(200, rss, { etag: '"v1"' });
        if (n === 2) return resp(304);
        return resp(200, "<html>not a feed</html>");
      },
      onItems: (_f, items) => got.push(items.length),
      onError: (_f, m) => errors.push(m),
    });
    await poller.poll(feeds[0]!);
    await poller.poll(feeds[0]!);
    expect(seenHeaders[1]!["if-none-match"]).toBe('"v1"');
    expect(got).toEqual([1]);
    await poller.poll(feeds[0]!);
    expect(errors[0]).toContain("illisible");
    expect(poller.feedsHealth()[0]).toMatchObject({ ok: false, items: 1 });
  });
});

const sig = (o: Partial<IntelSignal> = {}): IntelSignal => ({ id: Math.random().toString(36), ts: T0, coin: "SOL", coinName: null, kind: "PUMP_EARLY", direction: "bullish", source: "binance", strength: 80, title: "🚀 SOL monte", reasons: ["r"], metrics: {}, priceUsd: 100, url: null, ...o });

describe("DiscordNotifier", () => {
  const URL = "https://discord.com/api/webhooks/123/abc-DEF_1";
  const mk = (fetchText: FetchText, now: () => number, cfg = defaultIntelConfig().discord) => new DiscordNotifier({ webhookUrl: URL, cfg, fetchText, log: noLog, hitRateOf: () => 55, now });

  it("validates webhook URLs", () => {
    expect(isDiscordWebhookUrl(URL)).toBe(true);
    expect(isDiscordWebhookUrl("https://evil.example/api/webhooks/1/x")).toBe(false);
    const n = new DiscordNotifier({ webhookUrl: "http://discord.com/api/webhooks/1/x", cfg: defaultIntelConfig().discord, fetchText: async () => resp(200), log: noLog, hitRateOf: () => null });
    expect(n.view()).toMatchObject({ configured: false, state: "disabled" });
    expect(n.view().lastError).not.toContain("discord.com/api/webhooks/1/x");
  });
  it("routes strong signals immediately, weaker ones to the digest, respects per-coin cooldown", async () => {
    let now = T0;
    const bodies: { url: string; body: unknown }[] = [];
    const n = mk(async (url, init) => {
      bodies.push({ url, body: JSON.parse(init!.body!) });
      return resp(200, "{}");
    }, () => now);
    expect(n.consider(sig())).toBe("urgent");
    expect(n.consider(sig({ kind: "VOLUME_SURGE" }))).toBe("digest"); // same coin, cooldown
    expect(n.consider(sig({ coin: "ETH", strength: 60 }))).toBe("digest");
    expect(n.consider(sig({ coin: "BTC", strength: 30 }))).toBe("skip");
    expect(n.consider(sig({ coin: "BTC", direction: "neutral" }))).toBe("skip");
    expect(n.consider(sig({ kind: "CONFLUENCE" }))).toBe("urgent"); // always through
    await n.pump();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.url).toBe(`${URL}?wait=true`);
    const msg = bodies[0]!.body as { embeds: unknown[]; allowed_mentions: unknown };
    expect(msg.embeds).toHaveLength(2);
    expect(msg.allowed_mentions).toEqual({ parse: [] });
    now += 15 * 60_000;
    await n.pump();
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[1]!.body)).toContain("Résumé : 2 signal(s)");
  });
  it("honours 429 retry_after and keeps the message", async () => {
    let now = T0;
    let first = true;
    const sent: number[] = [];
    const n = mk(async () => {
      if (first) {
        first = false;
        return resp(429, JSON.stringify({ retry_after: 2.5, global: false }));
      }
      sent.push(now);
      return resp(200, "{}");
    }, () => now);
    n.consider(sig());
    await n.pump();
    expect(n.view().state).toBe("paused");
    now += 1000;
    await n.pump();
    expect(sent).toHaveLength(0);
    now += 2000;
    await n.pump();
    expect(sent).toHaveLength(1);
  });
  it("mentions the configured role only for very strong signals", async () => {
    const bodies: string[] = [];
    const cfg = IntelConfigSchema.parse({ discord: { mentionRoleId: "999", mentionMinStrength: 90 } }).discord;
    const n = mk(async (_u, init) => {
      bodies.push(init!.body!);
      return resp(200, "{}");
    }, () => T0, cfg);
    n.consider(sig({ strength: 95 }));
    await n.pump();
    expect(JSON.parse(bodies[0]!)).toMatchObject({ content: "<@&999> Signal fort", allowed_mentions: { parse: [], roles: ["999"] } });
  });
  it("reports a missing webhook on test", async () => {
    const n = new DiscordNotifier({ webhookUrl: null, cfg: defaultIntelConfig().discord, fetchText: async () => resp(200), log: noLog, hitRateOf: () => null });
    expect((await n.test()).ok).toBe(false);
  });
});

describe("IntelService + routes", () => {
  const mkService = (notifier: { consider: (s: IntelSignal) => unknown; view: () => unknown } | null = null) =>
    new IntelService({ cfg: defaultIntelConfig(), log: noLog, notifier, enabledSources: ["coingecko", "trending", "news"], now: () => T0 });

  it("ingests markets into the universe and produces signals; sorts and filters the universe", () => {
    const seen: IntelSignal[] = [];
    const svc = mkService({ consider: (s) => seen.push(s), view: () => ({}) });
    const rows = [marketRow("AAA", { market_cap_rank: 2 }), marketRow("BBB", { market_cap_rank: 1, price_change_percentage_1h_in_currency: 15 }), marketRow("CCC", { market_cap_rank: 3, price_change_percentage_24h_in_currency: -5 })].map((r) => CgMarketRowSchema.parse(r));
    svc.onMarkets(rows, 1, T0);
    expect(seen.map((s) => [s.coin, s.kind])).toEqual([["BBB", "TOP_MOVER_1H"]]);
    expect(svc.universe({}).rows.map((r) => r.symbol)).toEqual(["BBB", "AAA", "CCC"]);
    expect(svc.universe({ sort: "change24h" }).rows.map((r) => r.symbol)).toEqual(["AAA", "BBB", "CCC"]);
    expect(svc.universe({ filter: "losers" }).rows.map((r) => r.symbol)).toEqual(["CCC"]);
    expect(svc.universe({ filter: "signaled" }).rows[0]).toMatchObject({ symbol: "BBB", signals24h: 1 });
    expect(svc.universe({ q: "aaa coin" }).total).toBe(1);
    expect(svc.coinDetail("bbb").signals).toHaveLength(1);
    expect(svc.tracker.list()).toHaveLength(1);
  });
  it("news matching uses the universe dictionary", () => {
    const svc = mkService();
    svc.onMarkets([CgMarketRowSchema.parse(marketRow("SOL", { name: "Solana" }))], 1, T0);
    svc.onNews("CoinDesk", [{ title: "Solana network hacked, funds drained", link: "https://x/1", summary: "", ts: T0 - 60_000 }], T0);
    const news = svc.news({});
    expect(news[0]).toMatchObject({ coins: ["SOL"], direction: "bearish" });
    expect(svc.feed({ sources: ["news"] }).signals[0]).toMatchObject({ kind: "NEWS_BEARISH", coin: "SOL" });
  });
  it("trending entries only after the first poll; state survives export/import", () => {
    const svc = mkService();
    svc.onTrending([{ id: "a", symbol: "a", name: "A", rank: 0, marketCapRank: null }], T0);
    svc.onTrending([{ id: "a", symbol: "a", name: "A", rank: 0, marketCapRank: null }, { id: "b", symbol: "b", name: "B", rank: 1, marketCapRank: 400 }], T0);
    expect(svc.feed({}).signals.map((s) => s.coin)).toEqual(["B"]);
    const svc2 = mkService();
    svc2.restore(JSON.parse(JSON.stringify(svc.exportState({ x: 1 }))));
    expect(svc2.feed({}).signals).toHaveLength(1);
    svc2.onTrending([{ id: "a", symbol: "a", name: "A", rank: 0, marketCapRank: null }, { id: "b", symbol: "b", name: "B", rank: 1, marketCapRank: 400 }], T0);
    expect(svc2.feed({}).signals).toHaveLength(1);
  });
  it("routes: /api/intel/* validate input and redact secrets", async () => {
    const svc = mkService();
    svc.onMarkets([CgMarketRowSchema.parse(marketRow("AAA", { price_change_percentage_1h_in_currency: 20 }))], 1, T0);
    const ctx = { intel: svc, intelExtras: () => ({ coingecko: { apiKey: "CG-secret" } }) } as unknown as RouteContext;
    const q = (p: string) => {
      const u = new URL(p, "http://x");
      return handleGet(ctx, u.pathname, u.searchParams);
    };
    expect((q("/api/intel/feed?direction=bullish&minStrength=10")!.body as { signals: unknown[] }).signals).toHaveLength(1);
    expect((q("/api/intel/feed?direction=bearish")!.body as { signals: unknown[] }).signals).toHaveLength(0);
    expect((q("/api/intel/universe?sort=volume&limit=5")!.body as { total: number }).total).toBe(1);
    expect(q("/api/intel/coin/AAA")!.status).toBe(200);
    expect(q("/api/intel/coin/..%2F..%2Fetc")!.status).toBe(400);
    expect(JSON.stringify(q("/api/intel/sources")!.body)).not.toContain("CG-secret");
    expect(q("/api/intel/performance")!.status).toBe(200);
    expect(q("/api/intel/nope")).toBeNull();
    expect(handleGet({} as RouteContext, "/api/intel/feed", new URLSearchParams())!.status).toBe(404);
    const r = await handleAction(ctx, "/api/intel/discord/test", {});
    expect(r.status).toBe(409);
  });
});

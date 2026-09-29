import { describe, expect, it } from "vitest";
import { defaultIntelConfig } from "../src/intel/config.js";
import { aggregateDerivatives, detectDerivatives, detectLive, detectMarketRow, detectPools, detectTrendingEntries, type Candidate, type LiveSnapshot } from "../src/intel/detectors.js";
import { newsEmbed, packMessages, signalEmbed } from "../src/intel/discord.js";
import { IntelEngine } from "../src/intel/engine.js";
import { LiveTracker } from "../src/intel/live.js";
import { CoinMatcher, classifyNews, newsId, parseFeed, toNewsItem } from "../src/intel/news.js";
import { BinanceMiniTickerSchema, CgDerivativeSchema, CgMarketRowSchema, GtPoolsSchema } from "../src/intel/schemas.js";
import { OutcomeTracker } from "../src/intel/tracker.js";
import type { IntelSignal, NewsItem } from "../src/intel/types.js";

const cfg = defaultIntelConfig();
const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);

const live = (o: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
  coin: "PEPE",
  pair: "PEPEUSDT",
  priceUsd: 1,
  change5m: 0,
  change15m: 0,
  change1h: 0,
  volumeRatio1h: 1,
  volume24hUsd: 50_000_000,
  high24h: 1.2,
  low24h: 0.8,
  ...o,
});

const market = (o: Record<string, unknown> = {}) =>
  CgMarketRowSchema.parse({
    id: "pepe",
    symbol: "pepe",
    name: "Pepe",
    current_price: 1,
    market_cap: 1e9,
    market_cap_rank: 30,
    total_volume: 1e8,
    high_24h: 1.1,
    low_24h: 0.9,
    price_change_percentage_24h: 1,
    ath: 2,
    ath_change_percentage: -50,
    price_change_percentage_1h_in_currency: 0,
    price_change_percentage_24h_in_currency: 1,
    price_change_percentage_7d_in_currency: 3,
    ...o,
  });

const cand = (o: Partial<Candidate> = {}): Candidate => ({
  coin: "SOL",
  coinName: "Solana",
  kind: "PUMP_EARLY",
  direction: "bullish",
  source: "binance",
  strength: 70,
  title: "t",
  reasons: [],
  metrics: {},
  priceUsd: 100,
  url: null,
  ...o,
});

describe("intel detectors", () => {
  it("live: quiet market produces nothing", () => {
    expect(detectLive(live(), cfg.binance)).toEqual([]);
  });
  it("live: pump over 5 min is detected, stronger when bigger", () => {
    const a = detectLive(live({ change5m: 4.5 }), cfg.binance);
    const b = detectLive(live({ change5m: 10 }), cfg.binance);
    expect(a.map((c) => c.kind)).toEqual(["PUMP_EARLY"]);
    expect(b[0]!.strength).toBeGreaterThan(a[0]!.strength);
    expect(a[0]!.url).toContain("PEPE_USDT");
  });
  it("live: dump, volume surge, breakout / breakdown", () => {
    expect(detectLive(live({ change15m: -10 }), cfg.binance).map((c) => c.kind)).toEqual(["DUMP_EARLY"]);
    const surge = detectLive(live({ volumeRatio1h: 6, change1h: 3 }), cfg.binance);
    expect(surge.map((c) => [c.kind, c.direction])).toEqual([["VOLUME_SURGE", "bullish"]]);
    expect(detectLive(live({ priceUsd: 1.2, change15m: 2 }), cfg.binance).map((c) => c.kind)).toEqual(["BREAKOUT_24H_HIGH"]);
    expect(detectLive(live({ priceUsd: 0.8, change15m: -2 }), cfg.binance).map((c) => c.kind)).toEqual(["BREAKDOWN_24H_LOW"]);
  });
  it("live: illiquid pairs are ignored, thin markets are damped", () => {
    expect(detectLive(live({ change5m: 20, volume24hUsd: 10_000 }), cfg.binance)).toEqual([]);
    const thin = detectLive(live({ change5m: 6, volume24hUsd: 300_000 }), cfg.binance)[0]!;
    const deep = detectLive(live({ change5m: 6, volume24hUsd: 1e9 }), cfg.binance)[0]!;
    expect(deep.strength).toBeGreaterThan(thin.strength);
  });
  it("coingecko row: mover, crash, volume/mcap anomaly, near ATH; small caps ignored", () => {
    expect(detectMarketRow(market({ price_change_percentage_1h_in_currency: 12 }), cfg.coingecko).map((c) => c.kind)).toEqual(["TOP_MOVER_1H"]);
    expect(detectMarketRow(market({ price_change_percentage_1h_in_currency: -15 }), cfg.coingecko).map((c) => c.kind)).toEqual(["CRASH_1H"]);
    const anomaly = detectMarketRow(market({ total_volume: 9e8, price_change_percentage_24h_in_currency: -8 }), cfg.coingecko);
    expect(anomaly.map((c) => [c.kind, c.direction])).toEqual([["VOLUME_MCAP_ANOMALY", "bearish"]]);
    expect(detectMarketRow(market({ ath_change_percentage: -1, price_change_percentage_24h_in_currency: 6 }), cfg.coingecko).map((c) => c.kind)).toEqual(["NEAR_ATH"]);
    expect(detectMarketRow(market({ market_cap: 1000, price_change_percentage_1h_in_currency: 50 }), cfg.coingecko)).toEqual([]);
  });
  it("trending: nothing on first poll, only new entries afterwards", () => {
    const list = [
      { id: "pepe", symbol: "pepe", name: "Pepe", rank: 0, marketCapRank: 30 },
      { id: "wif", symbol: "wif", name: "dogwifhat", rank: 1, marketCapRank: 60 },
    ];
    expect(detectTrendingEntries(list, null, () => 1)).toEqual([]);
    const c = detectTrendingEntries(list, new Set(["pepe"]), () => 2);
    expect(c.map((x) => [x.coin, x.kind, x.priceUsd])).toEqual([["WIF", "TRENDING_ENTRY", 2]]);
  });
  it("derivatives: OI-weighted funding, extremes and OI surge", () => {
    const rows = [
      { market: "A", symbol: "BTCUSDT", index_id: "BTC", price: 1, price_percentage_change_24h: 3, contract_type: "perpetual", funding_rate: 0.1, open_interest: 9e8, volume_24h: 1 },
      { market: "B", symbol: "BTC-PERP", index_id: "BTC", price: 1, price_percentage_change_24h: 3, contract_type: "perpetual", funding_rate: -0.1, open_interest: 1e8, volume_24h: 1 },
      { market: "C", symbol: "BTC-Q", index_id: "BTC", price: 1, price_percentage_change_24h: 3, contract_type: "futures", funding_rate: 5, open_interest: 1e12, volume_24h: 1 },
    ].map((r) => CgDerivativeSchema.parse(r));
    const agg = aggregateDerivatives(rows).get("BTC")!;
    expect(agg.markets).toBe(2);
    expect(agg.openInterestUsd).toBe(1e9);
    expect(agg.fundingRatePct).toBeCloseTo(0.08, 6);
    const c = detectDerivatives(agg, 8e8, cfg.coingecko, 100);
    expect(c.map((x) => [x.kind, x.direction])).toEqual([
      ["FUNDING_EXTREME_LONG", "bearish"],
      ["OPEN_INTEREST_SURGE", "bullish"],
    ]);
    expect(detectDerivatives({ ...agg, openInterestUsd: 1e6 }, null, cfg.coingecko, 1)).toEqual([]);
  });
  it("dex: new pool traction, trending pump, rug risk", () => {
    const pool = (id: string, attrs: Record<string, unknown>) => ({
      id,
      attributes: { name: `${id.toUpperCase()} / WETH`, address: `0x${id}`, reserve_in_usd: "100000", ...attrs },
      relationships: { base_token: { data: { id: `eth_${id}` } }, network: { data: { id: "eth" } }, dex: { data: { id: "uniswap_v3" } } },
    });
    const doc = GtPoolsSchema.parse({
      data: [
        pool("new", { pool_created_at: new Date(T0 - 3_600_000).toISOString(), volume_usd: { h1: "120000" }, price_change_percentage: { h1: "30" }, transactions: { h1: { buys: 300, sells: 100 } } }),
        pool("pump", { pool_created_at: "2025-01-01T00:00:00Z", volume_usd: { h1: "90000" }, price_change_percentage: { h1: "60" }, transactions: { h1: { buys: 50, sells: 40 } } }),
        pool("rug", { volume_usd: { h1: "10000" }, price_change_percentage: { h1: "-80" }, transactions: { h1: { buys: 5, sells: 200 } } }),
        pool("small", { reserve_in_usd: "1000", volume_usd: { h1: "100" }, price_change_percentage: { h1: "90" } }),
      ],
      included: [
        { id: "eth_new", type: "token", attributes: { symbol: "NEWT", name: "New Token" } },
        { id: "eth_pump", type: "token", attributes: { symbol: "PMP", name: "Pump" } },
      ],
    });
    const c = detectPools(doc, cfg.coingecko.dex, T0, true);
    expect(c.map((x) => [x.coin, x.kind])).toEqual([
      ["NEWT", "DEX_NEW_POOL_TRACTION"],
      ["PMP", "DEX_TRENDING_PUMP"],
      ["RUG", "DEX_RUG_RISK"],
    ]);
    expect(c[2]!.reasons.length).toBeGreaterThanOrEqual(2);
    expect(c[0]!.url).toBe("https://www.geckoterminal.com/eth/pools/0xnew");
  });
});

describe("intel news", () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>X</title>
    <item><title>Solana &amp; friends surge after ETF approval</title><link>https://ex.com/a</link><pubDate>Tue, 01 Sep 2026 11:00:00 GMT</pubDate><description><![CDATA[<p>SOL rallies</p>]]></description></item>
    <item><title>Only title</title><link>https://ex.com/b</link></item>
  </channel></rss>`;
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Exchange hacked</title><link rel="alternate" href="https://ex.com/c"/><updated>2026-09-01T10:00:00Z</updated><summary>Funds drained</summary></entry></feed>`;

  it("parses RSS 2.0 and Atom, strips HTML, tolerates garbage", () => {
    const r = parseFeed(rss);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ title: "Solana & friends surge after ETF approval", link: "https://ex.com/a", summary: "SOL rallies", ts: Date.parse("2026-09-01T11:00:00Z") });
    const a = parseFeed(atom);
    expect(a).toEqual([{ title: "Exchange hacked", link: "https://ex.com/c", summary: "Funds drained", ts: Date.parse("2026-09-01T10:00:00Z") }]);
    expect(parseFeed("not xml <<<")).toEqual([]);
  });
  it("matches coins by $SYM, uppercase ticker and name; avoids ordinary words", () => {
    const m = new CoinMatcher([
      { symbol: "ETH", name: "Ethereum" },
      { symbol: "ETC", name: "Ethereum Classic" },
      { symbol: "SOL", name: "Solana" },
      { symbol: "ONE", name: "Harmony" },
      { symbol: "NEAR", name: "Near" },
      { symbol: "PEPE", name: "Pepe" },
    ]);
    expect(m.match("Ethereum Classic jumps").sort()).toEqual(["ETC"]);
    expect(m.match("Ethereum and Solana").sort()).toEqual(["ETH", "SOL"]);
    expect(m.match("ONE more thing, we are near the top")).toEqual([]);
    expect(m.match("$one and $pepe are pumping")).toEqual(["ONE", "PEPE"]);
    expect(m.match("NEAR Protocol upgrade")).toEqual(["NEAR"]);
  });
  it("classifies direction with explainable tags (EN + FR)", () => {
    expect(classifyNews("Binance will list PEPE", "")).toMatchObject({ direction: "bullish", tags: ["listing"] });
    expect(classifyNews("Protocol hacked, $50M drained", "").direction).toBe("bearish");
    expect(classifyNews("Le bitcoin s'envole après l'approbation", "").direction).toBe("bullish");
    expect(classifyNews("Faille critique : le protocole piraté", "").direction).toBe("bearish");
    expect(classifyNews("Le protocole piraté hier soir", "").tags).toEqual(["hack / exploit"]);
    expect(classifyNews("Weekly market recap", "").direction).toBe("neutral");
    // summary-only matches weigh half
    expect(classifyNews("Update", "a partnership").score).toBe(0.5);
  });
  it("newsId is stable and case-insensitive", () => {
    expect(newsId("https://EX.com/a", "x")).toBe(newsId("https://ex.com/a ", "y"));
    expect(newsId("", "Title")).not.toBe(newsId("", "Other"));
  });
});

describe("IntelEngine", () => {
  it("cooldown per coin × kind", () => {
    const e = new IntelEngine(cfg);
    expect(e.ingest([cand()], T0)).toHaveLength(1);
    expect(e.ingest([cand()], T0 + 30 * 60_000)).toHaveLength(0);
    expect(e.ingest([cand({ kind: "VOLUME_SURGE" })], T0 + 30 * 60_000)).toHaveLength(1);
    expect(e.ingest([cand()], T0 + 61 * 60_000)).toHaveLength(1);
  });
  it("confluence needs distinct eligible sources in the same direction", () => {
    const e = new IntelEngine(cfg);
    e.ingest([cand({ source: "binance" })], T0);
    expect(e.ingest([cand({ source: "binance", kind: "VOLUME_SURGE" })], T0 + 1000).some((s) => s.kind === "CONFLUENCE")).toBe(false);
    expect(e.ingest([cand({ source: "dex", kind: "DEX_TRENDING_PUMP" })], T0 + 2000).some((s) => s.kind === "CONFLUENCE")).toBe(false);
    expect(e.ingest([cand({ source: "coingecko", kind: "TOP_MOVER_1H", direction: "bearish" })], T0 + 3000).some((s) => s.kind === "CONFLUENCE")).toBe(false);
    const out = e.ingest([cand({ source: "trending", kind: "TRENDING_ENTRY", strength: 60 })], T0 + 4000);
    const conf = out.find((s) => s.kind === "CONFLUENCE")!;
    expect(conf).toBeDefined();
    expect(conf.metrics.sources).toBe("trending,binance");
    expect(conf.strength).toBe(78);
    expect(conf.related).toHaveLength(3);
    // no second confluence within cooldown
    expect(e.ingest([cand({ source: "coingecko", kind: "TOP_MOVER_1H" })], T0 + 5000).some((s) => s.kind === "CONFLUENCE")).toBe(false);
  });
  it("price sources alone never make a confluence (same move seen twice)", () => {
    const e = new IntelEngine(cfg);
    e.ingest([cand({ source: "binance" })], T0);
    e.ingest([cand({ source: "coinbase", kind: "VOLUME_SURGE" })], T0 + 1000);
    expect(e.ingest([cand({ source: "coingecko", kind: "TOP_MOVER_1H" })], T0 + 2000).some((s) => s.kind === "CONFLUENCE")).toBe(false);
    const c = e.ingest([cand({ source: "derivatives", kind: "FUNDING_EXTREME_SHORT" })], T0 + 3000).find((s) => s.kind === "CONFLUENCE")!;
    expect(c.metrics.families).toBe("dérivés,prix");
  });
  it("confluence window expires", () => {
    const e = new IntelEngine(cfg);
    e.ingest([cand({ source: "binance" })], T0);
    expect(e.ingest([cand({ source: "trending", kind: "TRENDING_ENTRY" })], T0 + 121 * 60_000).some((s) => s.kind === "CONFLUENCE")).toBe(false);
  });
  it("universe: markets, live overrides price, collisions keep the higher-ranked coin", () => {
    const e = new IntelEngine(cfg);
    e.upsertMarkets([market({ id: "pepe", market_cap_rank: 30, current_price: 1 }), market({ id: "pepe-fake", name: "Fake", market_cap_rank: 3000, current_price: 9 })], T0);
    expect(e.coin("pepe")).toMatchObject({ coingeckoId: "pepe", priceUsd: 1, rank: 30 });
    e.upsertLive(live({ priceUsd: 1.5 }), T0 + 1000, "binance");
    e.upsertMarkets([market({ current_price: 1.1 })], T0 + 2000);
    expect(e.priceOf("PEPE")).toBe(1.5);
    expect(e.coin("PEPE")!.onBinance).toBe(true);
    e.upsertMarkets([market({ current_price: 1.1 })], T0 + 10 * 60_000);
    expect(e.priceOf("PEPE")).toBe(1.1);
    expect(e.dictionary()).toEqual([{ symbol: "PEPE", name: "Pepe" }]);
  });
  it("news: dedup, signals only for fresh directional news, filters", () => {
    const e = new IntelEngine(cfg);
    const n = (id: string, o: Partial<NewsItem> = {}): NewsItem => ({ id, ts: T0 - 60_000, feed: "CoinDesk", title: "Solana surges", link: `https://x/${id}`, summary: "", coins: ["SOL"], direction: "bullish", tags: ["forte hausse"], ...o });
    const r1 = e.addNews([n("a"), n("old", { ts: T0 - 7 * 3_600_000 }), n("neutral", { direction: "neutral", tags: [] })], T0);
    expect(r1.news).toHaveLength(3);
    expect(r1.signals.map((s) => [s.kind, s.coin])).toEqual([["NEWS_BULLISH", "SOL"]]);
    expect(e.addNews([n("a")], T0).news).toHaveLength(0);
    expect(e.recentNews({ coin: "sol" })).toHaveLength(3);
    expect(e.recentSignals({ direction: "bearish" })).toHaveLength(0);
    expect(e.recentSignals({ sources: ["news"], minStrength: 50 })).toHaveLength(1);
  });
  it("state round-trips", () => {
    const e = new IntelEngine(cfg);
    e.ingest([cand()], T0);
    const e2 = new IntelEngine(cfg);
    e2.importState(JSON.parse(JSON.stringify(e.exportState())));
    expect(e2.recentSignals()).toHaveLength(1);
  });
});

describe("OutcomeTracker", () => {
  const sig = (o: Partial<IntelSignal> = {}): IntelSignal => ({ id: "s1", ts: T0, ...cand(), ...o });
  it("measures returns at horizons, signed stats by direction, MFE/MAE", () => {
    const t = new OutcomeTracker(cfg.tracking);
    t.track(sig());
    t.track(sig({ id: "s2", direction: "bearish", kind: "DUMP_EARLY" }));
    t.track(sig({ id: "nop", priceUsd: null }));
    let price = 105;
    t.tick(T0 + 5 * 60_000, () => price);
    price = 97;
    expect(t.tick(T0 + 15 * 60_000, () => price)).toBe(2);
    const bull = t.list().find((x) => x.id === "s1")!;
    expect(bull.returns["15"]).toBeCloseTo(-3, 6);
    expect(bull.mfePct).toBeCloseTo(5, 6);
    expect(bull.maePct).toBeCloseTo(-3, 6);
    const stats = t.stats();
    const bear = stats.find((s) => s.kind === "DUMP_EARLY")!;
    expect(bear.horizons["15"]).toMatchObject({ n: 1, hitRatePct: 100 });
    expect(bear.horizons["15"]!.avgPct).toBeCloseTo(3, 6);
    expect(stats.find((s) => s.kind === "PUMP_EARLY")!.horizons["15"]!.hitRatePct).toBe(0);
  });
  it("late measurements are NaN (excluded) and survive persistence", () => {
    const t = new OutcomeTracker(cfg.tracking);
    t.track(sig());
    t.tick(T0 + 30 * 60_000, () => 110); // 15-min horizon measured 15 min late
    expect(Number.isNaN(t.list()[0]!.returns["15"])).toBe(true);
    expect(t.stats()[0]!.horizons["15"]!.n).toBe(0);
    const t2 = new OutcomeTracker(cfg.tracking);
    t2.importState(JSON.parse(JSON.stringify(t.exportState())));
    expect(Number.isNaN(t2.list()[0]!.returns["15"])).toBe(true);
  });
  it("finishes after the longest horizon", () => {
    const t = new OutcomeTracker(cfg.tracking);
    t.track(sig());
    t.tick(T0 + 2 * 86_400_000, () => 100);
    expect(t.list()[0]!.done).toBe(true);
  });
});

describe("LiveTracker", () => {
  const symbols = new Map([
    ["PEPEUSDT", { base: "PEPE", quote: "USDT" }],
    ["PEPEUSDC", { base: "PEPE", quote: "USDC" }],
    ["WIFUSDC", { base: "WIF", quote: "USDC" }],
    ["ETHBTC", { base: "ETH", quote: "BTC" }],
  ]);
  const mini = (s: string, E: number, c: number) => BinanceMiniTickerSchema.parse({ e: "24hrMiniTicker", E, s, c: String(c), o: "1", h: "2", l: "0.5", v: "1000", q: "2400000" });

  it("picks one pair per coin by quote priority", () => {
    const t = new LiveTracker(symbols, ["USDT", "USDC"]);
    expect(t.coins().sort()).toEqual(["PEPE", "WIF"]);
    expect(t.applyMini(mini("PEPEUSDC", T0, 1), T0)).toBeNull();
    expect(t.applyMini(mini("ETHBTC", T0, 1), T0)).toBeNull();
    expect(t.applyMini(mini("WIFUSDC", T0, 1), T0)).toBe("WIF");
  });
  it("computes 5/15-min changes only once enough history exists, and the 1 h volume ratio", () => {
    const t = new LiveTracker(symbols, ["USDT"]);
    t.applyMini(mini("PEPEUSDT", T0, 1), T0);
    t.applyMini(mini("PEPEUSDT", T0 + 240_000, 1.02), T0 + 240_000);
    expect(t.snapshot("PEPE", T0 + 240_000)!.change5m).toBeNull();
    t.applyMini(mini("PEPEUSDT", T0 + 300_000, 1.05), T0 + 300_000);
    const s = t.snapshot("PEPE", T0 + 300_000)!;
    expect(s.change5m).toBeCloseTo(5, 6);
    expect(s.change15m).toBeNull();
    expect(s.volumeRatio1h).toBeNull();
    t.applyWindow({ e: "1hTicker", E: T0 + 300_000, s: "PEPEUSDT", P: 4, c: 1.05, q: 400_000 }, T0 + 300_000);
    const s2 = t.snapshot("PEPE", T0 + 300_000)!;
    expect(s2.volumeRatio1h).toBeCloseTo(4, 6);
    expect(s2.change1h).toBe(4);
  });
});

describe("Discord formatting", () => {
  const s: IntelSignal = { id: "x", ts: T0, ...cand({ title: "A".repeat(400), reasons: ["r1", "r2"], url: "https://x" }) };
  it("embeds respect field limits and never ping everyone", () => {
    const e = signalEmbed(s, 62.4);
    expect(e.title.length).toBe(256);
    expect(e.fields!.find((f) => f.name.startsWith("Historique"))!.value).toContain("62 %");
    const msgs = packMessages([e], { content: "hello", mentionRole: "123" });
    expect(msgs[0]!.content).toBe("<@&123> hello");
    expect(msgs[0]!.allowed_mentions).toEqual({ parse: [], roles: ["123"] });
    expect(packMessages([e])[0]!.allowed_mentions).toEqual({ parse: [] });
  });
  it("packs at most 10 embeds and ≤ 6000 chars per message", () => {
    const small = Array.from({ length: 23 }, () => signalEmbed({ ...s, title: "t" }, null));
    expect(packMessages(small).map((m) => m.embeds!.length)).toEqual([10, 10, 3]);
    const big = Array.from({ length: 6 }, () => ({ ...signalEmbed(s, null), description: "d".repeat(1500) }));
    const msgs = packMessages(big);
    for (const m of msgs) {
      const total = m.embeds!.reduce((t, e) => t + e.title.length + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0) + (e.fields ?? []).reduce((a, f) => a + f.name.length + f.value.length, 0), 0);
      expect(total).toBeLessThanOrEqual(6000);
    }
    expect(msgs.length).toBeGreaterThan(1);
    expect(msgs.slice(1).every((m) => m.content === undefined)).toBe(true);
  });
  it("news embed", () => {
    const m = new CoinMatcher([{ symbol: "SOL", name: "Solana" }]);
    const n = toNewsItem({ title: "Solana listing", link: "https://x/n", summary: "", ts: T0 }, "Decrypt", m);
    expect(n.coins).toEqual(["SOL"]);
    expect(newsEmbed(n)).toMatchObject({ url: "https://x/n", footer: { text: "Decrypt" } });
  });
});

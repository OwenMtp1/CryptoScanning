import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { RadarState, passesPrefs, sanitizePrefs, defaultPrefs } from "../../../deploy/discord-worker/src/worker.js";

const WEBHOOK = "https://discord.com/api/webhooks/123/tok_EN-secret";
const SITE = "https://crypto-radar.pages.dev";

function storage() {
  const m = new Map<string, unknown>();
  return { m, get: async (k: string) => structuredClone(m.get(k)), put: async (e: Record<string, unknown>) => void Object.entries(e).forEach(([k, v]) => m.set(k, structuredClone(v))) };
}

let price = 1;
let extraProducts: unknown[] = [];
let btc1h = 0;
let perps: unknown[] = [];
let klines1h: unknown[][] | null = null;
let binanceBlocked: string[] = [];
/** 300 hourly Binance klines of a steady uptrend with pullbacks. */
const uptrend = () => {
  const out: unknown[][] = [];
  let p = 100;
  const t0 = Date.now() - 300 * 3_600_000;
  for (let i = 0; i < 300; i++) {
    const o = p;
    p = p * (1 + 0.003 + Math.sin(i / 5) * 0.004);
    out.push([t0 + i * 3_600_000, String(o), String(Math.max(o, p) * 1.003), String(Math.min(o, p) * 0.997), String(p), "1000"]);
  }
  return out;
};
const posted: { body: string }[] = [];
const product = (id: string, p: number) => ({ product_id: id, price: String(p), price_percentage_change_24h: "1", volume_24h: "5000000", base_currency_id: id.split("-")[0], quote_currency_id: id.split("-")[1], status: "online", trading_disabled: false, is_disabled: false, product_type: "SPOT", approximate_quote_24h_volume: "50000000" });
const res = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });

/** One complete cycle of the bot = 3 runs 20 s apart (the slow sources are split in 3 steps). */
async function scan3(make: () => RadarState): Promise<Record<string, any>> {
  let last: Record<string, any> = {};
  for (let i = 0; i < 3; i++) {
    last = (await (await make().fetch(new Request("https://radar/scan"))).json()) as Record<string, any>;
    vi.setSystemTime(Date.now() + 20_000);
  }
  return last;
}

function fakeFetch(url: string, init?: { method?: string; body?: string }) {
  if (url.startsWith("https://www.okx.com/")) return res(JSON.stringify({ code: "0", data: [{ instId: "ZZZ-USDT", last: "1", open24h: "1", high24h: "1", low24h: "1", volCcy24h: "1000" }] }));
  if (url.startsWith("https://api.kucoin.com/")) return res(JSON.stringify({ code: "200000", data: { ticker: [{ symbol: "ZZZ-USDT", last: "1", high: "1", low: "1", volValue: "1000", changeRate: "0" }] } }));
  if (url.startsWith("https://api.mexc.com/")) return res(JSON.stringify([{ symbol: "ZZZUSDT", lastPrice: "1", openPrice: "1", highPrice: "1", lowPrice: "1", quoteVolume: "1000" }]));
  if (url.startsWith("https://discord.com/")) {
    posted.push({ body: init?.body ?? "" });
    return res("{}");
  }
  const bnHost = /^https:\/\/(data-api\.binance\.vision|api\d?\.binance\.com|api-gcp\.binance\.com|www\.binance\.com)\//.exec(url)?.[1];
  if (bnHost && binanceBlocked.includes(bnHost)) return res(JSON.stringify({ code: 0, msg: "Service unavailable from a restricted location" }), 451);
  if (bnHost && url.includes("/api/v3/klines") && url.includes("interval=1h") && klines1h) return res(JSON.stringify(klines1h));
  if (bnHost) return res(JSON.stringify([{ symbol: "WIFUSDT", openPrice: "1", highPrice: "2", lowPrice: "0.5", lastPrice: String(price), volume: "1", quoteVolume: "90000000", openTime: 0, closeTime: Date.now() }]));
  if (url.includes("product_type=FUTURE")) return res(JSON.stringify({ products: perps }));
  if (url.startsWith("https://api.coinbase.com/")) return res(JSON.stringify({ products: [product("PEPE-USD", price), product("BTC-USD", 100_000), product("BTC-EUR", 90_000), ...extraProducts] }));
  if (url.startsWith("https://fapi.binance.com/")) return res(JSON.stringify([{ symbol: "BTCUSDT", longShortRatio: "3.2" }]));
  if (url.startsWith(`${SITE}/api/cg/coins/markets`)) return res(url.includes("page=1") ? JSON.stringify([{ id: "bitcoin", symbol: "btc", name: "Bitcoin", current_price: 100_000, market_cap: 2e12, market_cap_rank: 1, total_volume: 5e10, price_change_percentage_1h_in_currency: btc1h, price_change_percentage_24h_in_currency: 0 }, { id: "pepe", symbol: "pepe", name: "Pepe", current_price: price, market_cap: 5e9, market_cap_rank: 30, total_volume: 1e8, price_change_percentage_1h_in_currency: 0.5, price_change_percentage_24h_in_currency: 1 }]) : "[]");
  if (url.startsWith(`${SITE}/api/cg/search/trending`)) return res(JSON.stringify({ coins: [] }));
  if (url.startsWith(`${SITE}/api/cg/derivatives`)) return res("[]");
  if (url.startsWith(`${SITE}/api/cg/onchain`)) return res(JSON.stringify({ data: [] }));
  if (url === `${SITE}/api/news`) return res(JSON.stringify({ feeds: [{ id: "decrypt", name: "Decrypt" }] }));
  if (url.startsWith(`${SITE}/api/news/`)) return res(`<rss><channel><item><title>Pepe surges as whales accumulate</title><link>https://decrypt.co/a${price}</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`);
  return res("{}", 404);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Discord worker", () => {
  it("first run is silent (welcome only), then pumps are alerted with cooldown, state persists, secrets never exposed", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 10, 12, 0), toFake: ["Date"] });
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: { method?: string; body?: string }) => fakeFetch(u, i)));
    const st = storage();
    const env = { RADAR: {} as never, DISCORD_WEBHOOK_URL: WEBHOOK, SITE_URL: `${SITE}/` };
    const run = () => scan3(() => new RadarState({ storage: st } as never, env));

    const s1 = await run();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain("Crypto Radar connecté");
    expect(s1.sources.coinbase).toBe("2 cryptos"); // one USD pair per coin

    // +8 % in 5 min on Coinbase, plus a bullish headline → alert(s).
    vi.setSystemTime(Date.now() + 5 * 60_000);
    price = 1.08;
    const s2 = await run();
    expect(s2.errors).toEqual([]);
    // No threshold, one notification per signal: Binance pump (WIF), Coinbase pump (PEPE), news, confluence…
    const msgs = posted.slice(1).map((p) => JSON.parse(p.body));
    expect(msgs.every((m) => m.embeds.length === 1)).toBe(true);
    const titles = msgs.map((m) => m.embeds[0].title).join(" | ");
    expect(titles).toContain("WIF décolle");
    expect(titles).toContain("PEPE décolle");
    expect(titles).toContain("PEPE : 2 types d'indices indépendants haussiers");
    expect(msgs[0].allowed_mentions).toEqual({ parse: [] });
    const afterSecond = posted.length;

    // Same move again 5 min later: the same event (coin × type) is not re-sent.
    vi.setSystemTime(Date.now() + 5 * 60_000);
    price = 1.17;
    await run();
    expect(posted.length).toBe(afterSecond);

    // Public status never contains the webhook token.
    const status = await (await new RadarState({ storage: st } as never, env).fetch(new Request("https://radar/status"))).text();
    expect(status).not.toContain("tok_EN-secret");
    expect(status).toContain("lastRunAt");
  });

  it("routes bullish and bearish alerts to separate channels", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 11, 12, 0), toFake: ["Date"] });
    const byHook: Record<string, string[]> = {};
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: { method?: string; body?: string }) => {
      if (u.startsWith("https://discord.com/")) (byHook[u.split("/")[5]!] ??= []).push(i?.body ?? "");
      return fakeFetch(u, i);
    }));
    const st = storage();
    const env = { RADAR: {} as never, DISCORD_WEBHOOK_BULLISH: "https://discord.com/api/webhooks/1/up", DISCORD_WEBHOOK_BEARISH: "https://discord.com/api/webhooks/2/down", SITE_URL: SITE };
    const run = () => scan3(() => new RadarState({ storage: st } as never, env));
    price = 1;
    await run();
    expect(byHook["1"]![0]).toContain("haussiers");
    expect(byHook["2"]![0]).toContain("baissiers");
    vi.setSystemTime(Date.now() + 5 * 60_000);
    price = 1.1;
    await run();
    expect(byHook["1"]!.length).toBeGreaterThan(2); // every bullish signal, one message each
    expect(byHook["1"]!.slice(1).every((b) => JSON.parse(b).embeds.length === 1)).toBe(true);
    expect(byHook["2"]!.length).toBe(1); // nothing bearish
  });

  it("relays the site's signals only with the right code, through the same cooldowns", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 12, 12, 0), toFake: ["Date"] });
    posted.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: { method?: string; body?: string }) => fakeFetch(u, i)));
    const st = storage();
    const env = { RADAR: {} as never, DISCORD_WEBHOOK_URL: WEBHOOK, SITE_URL: SITE, RELAY_KEY: "s3cret-code" };
    const obj = new RadarState({ storage: st } as never, env);
    price = 1;
    await scan3(() => obj); // warm-up + welcome
    expect(posted).toHaveLength(1);
    const sig = { id: "b1", ts: Date.now(), coin: "SOLX", kind: "PUMP_EARLY", direction: "bullish", source: "binance", strength: 88, title: "SOLX décolle : +9 % en 5 min", reasons: ["r"], priceUsd: 1.2, url: "https://www.binance.com/en/trade/SOLX_USDT" };
    const relay = (key: string, signals: unknown[]) => obj.fetch(new Request("https://radar/relay", { method: "POST", headers: { "x-relay-key": key }, body: JSON.stringify({ signals }) }));
    expect((await relay("wrong", [sig])).status).toBe(401);
    const r = (await (await relay("s3cret-code", [sig, { ...sig, id: "bad", coin: "<script>" }, { ...sig, id: "old", ts: Date.now() - 3_600_000 }])).json()) as { accepted: number; rejected: number; reasons: Record<string, number> };
    expect(r).toMatchObject({ accepted: 1, rejected: 2, reasons: { format: 1, "trop ancien": 1 } });
    expect(posted).toHaveLength(2);
    expect(posted[1]!.body).toContain("SOLX décolle");
    await relay("s3cret-code", [{ ...sig, id: "b2" }]); // same coin/direction within 1 h → not re-alerted
    expect(posted).toHaveLength(2);
    expect(await (await obj.fetch(new Request("https://radar/status"))).text()).not.toContain("s3cret");
  });

  it("a retired instance (before the move to Europe) stops its loop instead of sending duplicates", async () => {
    const f = vi.fn(async (u: string, i?: { method?: string; body?: string }) => fakeFetch(u, i));
    vi.stubGlobal("fetch", f);
    const st = storage();
    await new RadarState({ storage: st } as never, { RADAR: {} as never, DISCORD_WEBHOOK_URL: WEBHOOK }).alarm();
    expect(f).not.toHaveBeenCalled();
    st.m.set("active", "eu-1");
    await new RadarState({ storage: st } as never, { RADAR: {} as never, DISCORD_WEBHOOK_URL: WEBHOOK }).alarm();
    expect(f).toHaveBeenCalled();
  });

  it("Discord settings: validated, protected by the relay code, and applied to what is sent", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 13, 12, 0), toFake: ["Date"] });
    posted.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: { method?: string; body?: string }) => fakeFetch(u, i)));
    const st = storage();
    const env = { RADAR: {} as never, DISCORD_WEBHOOK_URL: WEBHOOK, SITE_URL: SITE, RELAY_KEY: "code-1234567890" };
    const obj = new RadarState({ storage: st } as never, env);
    const prefs = (key: string, body: unknown) => obj.fetch(new Request("https://radar/prefs", { method: "POST", headers: { "x-relay-key": key }, body: JSON.stringify(body) }));
    expect((await prefs("bad", { minStrength: 50 })).status).toBe(401);
    expect((await prefs("code-1234567890", { minStrength: 500 })).status).toBe(400);
    const ok = (await (await prefs("code-1234567890", { minStrength: 0, kinds: ["NEW_LISTING", "NOT_A_KIND"], directions: ["bullish"], excludeCoins: ["doge"] })).json()) as { prefs: { kinds: string[]; excludeCoins: string[] } };
    expect(ok.prefs.kinds).toEqual(["NEW_LISTING"]);
    expect(ok.prefs.excludeCoins).toEqual(["DOGE"]);
    const view = (await (await obj.fetch(new Request("https://radar/prefs"))).json()) as { prefs: { kinds: string[] }; kinds: string[] };
    expect(view.prefs.kinds).toEqual(["NEW_LISTING"]);
    expect(view.kinds).toContain("LEVERAGE_LONG");
    // Warm-up, then a pump: filtered out (only NEW_LISTING allowed) → only the welcome message.
    price = 1;
    await scan3(() => obj);
    vi.setSystemTime(Date.now() + 5 * 60_000);
    price = 1.1;
    const s2 = (await scan3(() => obj)) as { filteredByPrefs: number };
    expect(posted).toHaveLength(1);
    expect(s2.filteredByPrefs).toBeGreaterThan(0);
  });

  it("detects new listings (after a silent first pass) and routes leverage signals to their channel", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 14, 12, 0), toFake: ["Date"] });
    const byHook: Record<string, string[]> = {};
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: { method?: string; body?: string }) => {
      if (u.startsWith("https://discord.com/")) (byHook[u.split("/")[5]!] ??= []).push(i?.body ?? "");
      return fakeFetch(u, i);
    }));
    const st = storage();
    const env = { RADAR: {} as never, DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/10/g", DISCORD_WEBHOOK_LEVERAGE: "https://discord.com/api/webhooks/20/lev", SITE_URL: SITE };
    const run = () => scan3(() => new RadarState({ storage: st } as never, env));
    price = 1;
    extraProducts = [];
    perps = [{ product_id: "BTC-PERP-INTX", price: "100000", status: "online", approximate_quote_24h_volume: "5e9", future_product_details: { contract_root_unit: "BTC", contract_expiry_type: "PERPETUAL", contract_display_name: "BTC PERP", perpetual_details: { max_leverage: "20", funding_rate: "0.001", open_interest: "100" } } }];
    await run();
    expect(byHook["20"]![0]).toContain("marchés à levier");
    vi.setSystemTime(Date.now() + 5 * 60_000);
    extraProducts = [product("ZORA-USD", 0.5)];
    btc1h = -4; // Bitcoin falls: momentum joins funding + crowded longs
    await run();
    const general = (byHook["10"] ?? []).slice(1).map((b) => JSON.parse(b).embeds[0].title).join(" | ");
    expect(general).toContain("🆕 ZORA arrive sur Coinbase");
    const lev = (byHook["20"] ?? []).slice(1).map((b) => JSON.parse(b).embeds[0].title).join(" | ");
    expect(lev).toContain("BTC PERP : indication SHORT"); // funding 0.1 % + 3.2 longs per short + BTC −4 % in 1 h
    expect(general).not.toContain("indication SHORT");
    const board = (await (await new RadarState({ storage: st } as never, env).fetch(new Request("https://radar/leverage"))).json()) as { markets: { coin: string; bias: string; maxLeverage: number }[] };
    expect(board.markets[0]).toMatchObject({ coin: "BTC", bias: "SHORT", maxLeverage: 20 });
    const stats = (await (await new RadarState({ storage: st } as never, env).fetch(new Request("https://radar/stats"))).json()) as { recent: unknown[] };
    expect(stats.recent.length).toBeGreaterThan(0); // outcomes tracked 24/7
    const sig = (await (await new RadarState({ storage: st } as never, env).fetch(new Request("https://radar/signals"))).json()) as { signals: unknown[] };
    expect(sig.signals.length).toBeGreaterThan(0);
    extraProducts = [];
    perps = [];
    btc1h = 0;
  });

  it("neutral signals reach Discord even without a neutral channel; long titles and special symbols are accepted", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 15, 12, 0), toFake: ["Date"] });
    const byHook: Record<string, string[]> = {};
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: { method?: string; body?: string }) => {
      if (u.startsWith("https://discord.com/")) (byHook[u.split("/")[5]!] ??= []).push(i?.body ?? "");
      return fakeFetch(u, i);
    }));
    const st = storage();
    const env = { RADAR: {} as never, DISCORD_WEBHOOK_BULLISH: "https://discord.com/api/webhooks/1/up", DISCORD_WEBHOOK_BEARISH: "https://discord.com/api/webhooks/2/down", SITE_URL: SITE, RELAY_KEY: "k-123456789012345" };
    const obj = new RadarState({ storage: st } as never, env);
    price = 1;
    await scan3(() => obj);
    const base = { ts: Date.now(), coinName: null, source: "dex", strength: 40, reasons: [], priceUsd: null, url: null };
    const r = (await (
      await obj.fetch(
        new Request("https://radar/relay", {
          method: "POST",
          headers: { "x-relay-key": "k-123456789012345" },
          body: JSON.stringify({ signals: [{ ...base, id: "n1", coin: "SOLX", kind: "VOLUME_SURGE", direction: "neutral", title: "SOLX volume x6" }, { ...base, id: "d1", coin: "$Ωmega", kind: "DEX_TRENDING_PUMP", direction: "bullish", title: "T".repeat(400) }] }),
        }),
      )
    ).json()) as { accepted: number };
    expect(r.accepted).toBe(2);
    const up = byHook["1"]!.slice(1).map((b) => JSON.parse(b).embeds[0].title);
    const down = byHook["2"]!.slice(1).map((b) => JSON.parse(b).embeds[0].title);
    expect(up.some((t: string) => t.startsWith("⚪ SOLX volume"))).toBe(true); // neutral → both channels
    expect(down.some((t: string) => t.startsWith("⚪ SOLX volume"))).toBe(true);
    expect(up.some((t: string) => t.length === 256)).toBe(true); // long title cut, not refused
  });

  it("a dedicated neutral channel (DISCORD_WEBHOOK_NEUTRAL) gets the neutral signals, and only them", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 16, 12, 0), toFake: ["Date"] });
    const byHook: Record<string, string[]> = {};
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: { method?: string; body?: string }) => {
      if (u.startsWith("https://discord.com/")) (byHook[u.split("/")[5]!] ??= []).push(i?.body ?? "");
      return fakeFetch(u, i);
    }));
    const st = storage();
    const env = { RADAR: {} as never, DISCORD_WEBHOOK_BULLISH: "https://discord.com/api/webhooks/1/up", DISCORD_WEBHOOK_BEARISH: "https://discord.com/api/webhooks/2/down", DISCORD_WEBHOOK_NEUTRAL: "https://discord.com/api/webhooks/3/mid", SITE_URL: SITE, RELAY_KEY: "k-123456789012345" };
    const obj = new RadarState({ storage: st } as never, env);
    price = 1;
    await scan3(() => obj);
    expect(byHook["3"]![0]).toContain("signaux **neutres**");
    const sig = { ts: Date.now(), coinName: null, source: "binance", strength: 50, reasons: [], priceUsd: null, url: null, kind: "VOLUME_SURGE", coin: "SOLX" };
    await obj.fetch(new Request("https://radar/relay", { method: "POST", headers: { "x-relay-key": "k-123456789012345" }, body: JSON.stringify({ signals: [{ ...sig, id: "n1", direction: "neutral", title: "SOLX volume x6" }] }) }));
    expect(byHook["3"]!.slice(1).map((b) => JSON.parse(b).embeds[0].title)).toEqual(["SOLX volume x6"]);
    expect(byHook["1"]!.slice(1).some((b) => b.includes("SOLX volume"))).toBe(false);
    expect(byHook["2"]!.slice(1).some((b) => b.includes("SOLX volume"))).toBe(false);
  });

  it("leverage setups already present at startup are alerted once the bot is live (threshold ±25), and every channel can be tested", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 17, 12, 0), toFake: ["Date"] });
    const byHook: Record<string, string[]> = {};
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: { method?: string; body?: string }) => {
      if (u.startsWith("https://discord.com/")) (byHook[u.split("/")[5]!] ??= []).push(i?.body ?? "");
      return fakeFetch(u, i);
    }));
    const st = storage();
    const env = { RADAR: {} as never, DISCORD_WEBHOOK_NEUTRAL: "https://discord.com/api/webhooks/3/mid", DISCORD_WEBHOOK_LEVERAGE: "https://discord.com/api/webhooks/4/lev", SITE_URL: SITE, RELAY_KEY: "k-123456789012345" };
    const run = () => scan3(() => new RadarState({ storage: st } as never, env));
    // funding 0.1 % + 3.2 longs per short = −27: SHORT already on the first (silent) pass.
    perps = [{ product_id: "BTC-PERP-INTX", price: "100000", status: "online", approximate_quote_24h_volume: "5e9", future_product_details: { contract_root_unit: "BTC", contract_expiry_type: "PERPETUAL", contract_display_name: "BTC PERP", perpetual_details: { max_leverage: "20", funding_rate: "0.001", open_interest: "100" } } }];
    price = 1;
    await run();
    expect((byHook["4"] ?? []).length).toBe(1); // welcome only
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await run();
    const lev = (byHook["4"] ?? []).slice(1).map((b) => JSON.parse(b).embeds[0].title).join(" | ");
    expect(lev).toContain("BTC PERP : indication SHORT");
    const status = (await (await new RadarState({ storage: st } as never, env).fetch(new Request("https://radar/status"))).json()) as { sent24h: { byChannel: Record<string, number> } };
    expect(status.sent24h.byChannel.levier).toBeGreaterThan(0);
    // Test every channel
    const bad = await new RadarState({ storage: st } as never, env).fetch(new Request("https://radar/test-channels", { method: "POST", headers: { "x-relay-key": "nope" } }));
    expect(bad.status).toBe(401);
    const t = (await (await new RadarState({ storage: st } as never, env).fetch(new Request("https://radar/test-channels", { method: "POST", headers: { "x-relay-key": "k-123456789012345" } }))).json()) as { results: { channel: string; ok: boolean }[]; missing: string[] };
    expect(t.results.map((r) => [r.channel, r.ok])).toEqual([["général", true], ["levier", true]]);
    expect(t.missing.join()).toContain("DISCORD_WEBHOOK_BULLISH");
    expect(byHook["3"]!.some((b) => b.includes("🧪"))).toBe(true);
    perps = [];
  });

  it("never more than 50 outgoing requests per run, even with a burst of alerts: the rest leaves on the next runs", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 18, 12, 0), toFake: ["Date"] });
    const perRun: number[] = [];
    let calls = 0;
    let discord = 0;
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: { method?: string; body?: string }) => {
      calls++;
      if (u.startsWith("https://discord.com/")) discord += (JSON.parse(i?.body ?? "{}").embeds ?? []).filter((e: { title: string }) => /C\d+X/.test(e.title)).length;
      return fakeFetch(u, i);
    }));
    const st = storage();
    const env = { RADAR: {} as never, DISCORD_WEBHOOK_URL: WEBHOOK, SITE_URL: SITE };
    const obj = new RadarState({ storage: st } as never, env);
    price = 1;
    extraProducts = Array.from({ length: 80 }, (_, i) => product(`C${i}X-USD`, 1));
    const once = async () => {
      calls = 0;
      await obj.fetch(new Request("https://radar/scan"));
      perRun.push(calls);
      vi.setSystemTime(Date.now() + 20_000);
    };
    for (let i = 0; i < 3; i++) await once(); // warm-up cycle
    vi.setSystemTime(Date.now() + 5 * 60_000);
    // 80 coins pump at once on Coinbase → 80+ alerts
    extraProducts = Array.from({ length: 80 }, (_, i) => product(`C${i}X-USD`, 1.1));
    const before = discord;
    for (let i = 0; i < 8; i++) await once();
    expect(Math.max(...perRun)).toBeLessThanOrEqual(50);
    expect(discord - before).toBeGreaterThanOrEqual(80); // every signal sent (grouped by 5 during the burst to stay within Discord limits)
    extraProducts = [];
  });

  it("prefs helpers", () => {
    const s = { id: "x", ts: 0, coin: "SOL", coinName: null, kind: "PUMP_EARLY" as const, direction: "bullish" as const, source: "binance" as const, strength: 60, title: "t", reasons: [], metrics: {}, priceUsd: 1, url: null };
    expect(passesPrefs(defaultPrefs(), s, null)).toBe(true);
    expect(passesPrefs({ ...defaultPrefs(), minStrength: 70 }, s, null)).toBe(false);
    expect(passesPrefs({ ...defaultPrefs(), minHitRate: 50 }, s, 40)).toBe(false);
    expect(passesPrefs({ ...defaultPrefs(), minHitRate: 50 }, s, null)).toBe(true); // not measured yet
    expect(passesPrefs({ ...defaultPrefs(), includeCoins: ["ETH"] }, s, null)).toBe(false);
    expect(sanitizePrefs({ minStrength: 10, directions: [] }, 1)!.directions).toEqual(["bullish", "bearish", "neutral"]);
  });

  it("runs on Coinbase alone when SITE_URL is missing and says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: { method?: string; body?: string }) => fakeFetch(u, i)));
    const st = storage();
    const s = (await (await new RadarState({ storage: st } as never, { RADAR: {} as never }).fetch(new Request("https://radar/scan"))).json()) as { errors: string[]; config: { webhookConfigured: boolean } };
    expect(s.errors.join()).toContain("SITE_URL non configurée");
    expect(s.config.webhookConfigured).toBe(false);
  });

  it("computes trader setups 24/7 and alerts a LONG setup once, with its full plan", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 20, 12, 0), toFake: ["Date"] });
    posted.length = 0;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: { method?: string; body?: string }) => {
      calls.push(u);
      return fakeFetch(u, i);
    }));
    klines1h = uptrend();
    try {
      const st = storage();
      const env = { RADAR: {} as never, DISCORD_WEBHOOK_URL: WEBHOOK, SITE_URL: SITE };
      const run = () => scan3(() => new RadarState({ storage: st } as never, env));
      price = 1;
      await run(); // warm-up: analysed, not alerted
      const before = posted.length;
      await run();
      const setups = posted.slice(before).map((p) => JSON.parse(p.body).embeds?.[0]?.title as string).filter((t) => /setup LONG/.test(t ?? ""));
      expect(setups.length).toBeGreaterThan(0);
      expect(setups[0]).toMatch(/entrée .* stop .* objectifs/);
      // Same setup on the next cycles: not repeated.
      const n = posted.length;
      await run();
      expect(posted.slice(n).some((p) => /setup LONG/.test(p.body))).toBe(false);
      const board = (await (await new RadarState({ storage: st } as never, env).fetch(new Request("https://radar/setups"))).json()) as { count: number; setups: { coin: string; setup: { bias: string } }[] };
      expect(board.count).toBeGreaterThan(0);
      expect(board.setups[0]!.setup.bias).toBe("LONG");
      expect(calls.some((u) => u.includes("interval=1h"))).toBe(true);
    } finally {
      klines1h = null;
    }
  });

  it("refuses oversized relay / settings bodies even without a Content-Length", async () => {
    const big = new ReadableStream({
      start(c) {
        for (let i = 0; i < 70; i++) c.enqueue(new TextEncoder().encode("x".repeat(1000)));
        c.close();
      },
    });
    const env = { RADAR: { idFromName: () => { throw new Error("must not reach the bot"); } } as never };
    const r = await worker.fetch(new Request("https://bot/relay", { method: "POST", body: big, duplex: "half" } as RequestInit), env as never);
    expect(r.status).toBe(413);
  });

  it("Binance refusing one access point: the bot switches to another one and Binance alerts still reach Discord", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 21, 12, 0), toFake: ["Date"] });
    posted.length = 0;
    binanceBlocked = ["data-api.binance.vision"];
    try {
      vi.stubGlobal("fetch", vi.fn(async (u: string, i?: { method?: string; body?: string }) => fakeFetch(u, i)));
      const st = storage();
      const env = { RADAR: {} as never, DISCORD_WEBHOOK_URL: WEBHOOK, SITE_URL: SITE, DISCORD_MIN_STRENGTH: "95" };
      const run = () => scan3(() => new RadarState({ storage: st } as never, env));
      price = 1;
      await run();
      vi.setSystemTime(Date.now() + 5 * 60_000);
      price = 1.08;
      const s = await run();
      expect(s.binance.host).toBe("https://api.binance.com");
      expect(s.sources.binance).toContain("api.binance.com");
      // The old DISCORD_MIN_STRENGTH no longer hides weaker signals.
      expect(posted.map((p) => p.body).join(" ")).toContain("WIF décolle");
      expect(s.sent24h.bySource.binance).toBeGreaterThan(0);
    } finally {
      binanceBlocked = [];
    }
  });

  it("tells the site what happened on Discord to every relayed signal", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 22, 12, 0), toFake: ["Date"] });
    posted.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: { method?: string; body?: string }) => fakeFetch(u, i)));
    const st = storage();
    const env = { RADAR: {} as never, DISCORD_WEBHOOK_URL: WEBHOOK, SITE_URL: SITE, RELAY_KEY: "k-123" };
    const obj = new RadarState({ storage: st } as never, env);
    // Not warmed up yet: the site's live signals are still sent.
    const sig = { id: "s1", ts: Date.now(), coin: "ABCX", kind: "PUMP_EARLY", direction: "bullish", source: "binance", strength: 5, title: "ABCX décolle", reasons: [], priceUsd: 1, url: null };
    const relay = async (signals: unknown[]) => (await (await obj.fetch(new Request("https://radar/relay", { method: "POST", headers: { "x-relay-key": "k-123" }, body: JSON.stringify({ signals }) }))).json()) as { results: Record<string, string> };
    const r = await relay([sig, { ...sig, id: "s2" }, { ...sig, id: "s3", kind: "NOPE" }]);
    expect(r.results).toEqual({ s1: "sent", s2: "dup", s3: "refused:type" });
    expect(posted.some((p) => p.body.includes("ABCX décolle"))).toBe(true);
    // Filtered by the settings → said so.
    await obj.fetch(new Request("https://radar/prefs", { method: "POST", headers: { "x-relay-key": "k-123" }, body: JSON.stringify({ ...defaultPrefs(), minStrength: 50 }) }));
    const r2 = await relay([{ ...sig, id: "s4", coin: "DEFX" }]);
    expect(r2.results.s4).toBe("filtered");
  });
});
